#!/usr/bin/env python3
# ==============================================================================
# Fleet sign-in service: the program that runs ON a server, as root.
# ==============================================================================
# Installed by scripts/install-fleet-sso-agent.sh as /usr/local/sbin/fleet-sso-agent
# and kept running by systemd (fleet-sso-agent.service).
#
# What it does, and all it does:
#   1. asks Fleet's database "any sign-in requests for this server?" (an
#      outbound HTTPS call; it listens on nothing, so no firewall change)
#   2. for each request, checks Fleet's signature with the public key in
#      /etc/fleet-sso/sign-pub.pem. No valid signature, no action.
#   3. runs the command GridPane's own panel runs for its SSO button:
#        gp wp <site> login create <user id> --url-only --expires=60
#   4. seals the link to Fleet's public key (/etc/fleet-sso/box-pub.pem) and
#      sends the sealed text back. Only Fleet can open it.
#
# What it never does: install, change or remove anything on a site; run a shell
# (every command is an argument list); print or log a sign-in link; act on a
# request for another server, a site folder that does not exist, or a site
# frozen for a move.
#
# Its own limits, whatever Fleet asks: 6 sign-ins a minute; a request is used
# once; a request issued before this service started is refused.
#
#   fleet-sso-agent            run until stopped
#   fleet-sso-agent --once     one round, then exit (the tests and the installer)
#   fleet-sso-agent --check    read the settings, test the keys and the token,
#                              mint nothing
#
# Standard library only, and written for Python 3.6, the oldest on a GridPane
# server. FLEET_SSO_ROOT is for the local test only: it prefixes every path.
# ==============================================================================
import base64
import collections
import json
import os
import random
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.environ.get("FLEET_SSO_ROOT", "")
CONF_DIR = ROOT + "/etc/fleet-sso"
CONF = CONF_DIR + "/agent.conf"
SIGN_PUB = CONF_DIR + "/sign-pub.pem"
BOX_PUB = CONF_DIR + "/box-pub.pem"
WWW = ROOT + "/var/www"


def _find_gp():
    # GridPane's command line tool. Looked up once, at start, in the places it is installed.
    for path in ("/usr/local/bin/gp", "/usr/bin/gp", "/usr/local/sbin/gp", "/usr/sbin/gp"):
        if os.access(ROOT + path, os.X_OK):
            return ROOT + path
    return ROOT + "/usr/local/bin/gp"


GP = _find_gp()
# On a server this is the system's openssl. The test may name another, because
# macOS ships LibreSSL, which cannot seal the way Fleet opens.
OPENSSL = os.environ.get("FLEET_SSO_OPENSSL", "/usr/bin/openssl") if ROOT else "/usr/bin/openssl"

HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
LINK_RE = re.compile(r"^https://([a-z0-9.-]+)/[A-Za-z0-9/_~.-]{8,200}$")
B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")

LINK_LIFE = 60          # seconds a minted link stays usable
MAX_PER_MINUTE = 6
GP_TIMEOUT = int(os.environ.get("FLEET_SSO_GP_TIMEOUT", "40")) if ROOT else 40   # the override is for the local test
SKEW = 30               # seconds of clock difference tolerated
MAX_REQUEST_LIFE = 180  # a request claiming to live longer than this is refused

POLL_ARMED = 1.0        # someone has Fleet open on a sites page
POLL_IDLE = 10.0
POLL_OFF = 60.0         # one-click sign-in is switched off in Fleet

STARTED = int(time.time())
seen = {}                                  # request id -> when to forget it
recent = collections.deque()               # times of recent sign-ins
stopping = False


def log(msg):
    # journald adds the time. Never pass a link or a token to this.
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


class Refuse(Exception):
    """A request this service will not carry out. `public` is shown to the person in Fleet."""

    def __init__(self, public, private=None):
        Exception.__init__(self, private or public)
        self.public = public


# ------------------------------------------------------------------------------
# Settings
# ------------------------------------------------------------------------------
def read_conf():
    try:
        st = os.stat(CONF)
    except OSError:
        raise SystemExit("ABORT: %s is missing. Run install-fleet-sso-agent.sh." % CONF)
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SystemExit("ABORT: %s can be read by other users. It holds this server's token: chmod 600." % CONF)
    if not ROOT and st.st_uid != 0:
        raise SystemExit("ABORT: %s is not owned by root." % CONF)
    conf = {}
    with open(CONF) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            conf[k.strip()] = v.strip().strip('"')
    url = conf.get("SUPABASE_URL", "")
    if not re.match(r"^https://[a-z0-9.-]+$", url) and not (ROOT and re.match(r"^http://127\.0\.0\.1:\d+$", url)):
        raise SystemExit("ABORT: SUPABASE_URL in %s is not an https address." % CONF)
    if not re.match(r"^[A-Za-z0-9._-]{20,}$", conf.get("SUPABASE_ANON_KEY", "")):
        raise SystemExit("ABORT: SUPABASE_ANON_KEY in %s is missing." % CONF)
    if not re.match(r"^[1-9][0-9]{0,11}$", conf.get("SERVER_ID", "")):
        raise SystemExit("ABORT: SERVER_ID in %s is not a number." % CONF)
    if not re.match(r"^[0-9a-f]{64}$", conf.get("AGENT_TOKEN", "")):
        raise SystemExit("ABORT: AGENT_TOKEN in %s is not set. Run install-fleet-sso-agent.sh." % CONF)
    conf["SERVER_ID"] = int(conf["SERVER_ID"])
    for path in (SIGN_PUB, BOX_PUB):
        if not os.path.isfile(path):
            raise SystemExit("ABORT: %s is missing. Run install-fleet-sso-agent.sh." % path)
    return conf


# ------------------------------------------------------------------------------
# Fleet's database: two calls, both outbound
# ------------------------------------------------------------------------------
class TokenRejected(Exception):
    pass


def rpc(conf, fn, args):
    body = json.dumps(args).encode()
    req = urllib.request.Request(
        "%s/rest/v1/rpc/%s" % (conf["SUPABASE_URL"], fn),
        data=body,
        method="POST",
        headers={
            "apikey": conf["SUPABASE_ANON_KEY"],
            "Authorization": "Bearer " + conf["SUPABASE_ANON_KEY"],
            "Content-Type": "application/json",
            "User-Agent": "fleet-sso-agent/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode() or "null")
    except urllib.error.HTTPError as e:
        text = e.read(2000).decode("utf-8", "replace")
        if '"42501"' in text or e.code in (401, 403):
            raise TokenRejected()
        raise RuntimeError("database answered HTTP %d" % e.code)


def poll(conf):
    return rpc(conf, "sso_agent_poll", {"p_server_id": conf["SERVER_ID"], "p_token": conf["AGENT_TOKEN"]})


def complete(conf, request_id, sealed=None, error=None):
    args = {"p_server_id": conf["SERVER_ID"], "p_token": conf["AGENT_TOKEN"], "p_request_id": request_id}
    if sealed is not None:
        args["p_sealed_link"] = sealed
    else:
        args["p_error"] = (error or "the server could not create a sign-in link")[:200]
    return rpc(conf, "sso_agent_complete", args)


# ------------------------------------------------------------------------------
# One request
# ------------------------------------------------------------------------------
def b64url_decode(text):
    if not B64URL_RE.match(text):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_signature(signed, signature):
    """True only if Fleet's private key signed these exact bytes."""
    with tempfile.NamedTemporaryFile(prefix="fleet-sso-sig-") as sig:
        sig.write(signature)
        sig.flush()
        p = subprocess.run(
            [OPENSSL, "dgst", "-sha256", "-verify", SIGN_PUB, "-signature", sig.name],
            input=signed, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
        )
    return p.returncode == 0 and b"Verified OK" in p.stdout


def read_request(conf, item, now):
    """Check everything about a request before anything is run. Returns (id, site)."""
    request_id = item.get("id") if isinstance(item, dict) else None
    signed_request = item.get("signed_request") if isinstance(item, dict) else None
    if not isinstance(request_id, str) or not UUID_RE.match(request_id):
        raise Refuse("the server did not accept the request", "request has no usable id")
    if not isinstance(signed_request, str) or len(signed_request) > 4096:
        raise Refuse("the server did not accept the request", "no signed request")
    parts = signed_request.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        raise Refuse("the server did not accept the request", "signed request has the wrong shape")
    try:
        signature = b64url_decode(parts[2])
        raw_payload = b64url_decode(parts[1])
    except Exception:
        raise Refuse("the server did not accept the request", "signed request is not base64url")
    # The signature is checked BEFORE the payload is trusted for anything.
    if not verify_signature((parts[0] + "." + parts[1]).encode("ascii"), signature):
        raise Refuse("the server did not accept the request", "signature is not Fleet's")
    try:
        p = json.loads(raw_payload.decode("utf-8"))
    except Exception:
        raise Refuse("the server did not accept the request", "payload is not JSON")
    if not isinstance(p, dict) or p.get("v") != 1:
        raise Refuse("the server did not accept the request", "unknown request version")
    if p.get("id") != request_id:
        raise Refuse("the server did not accept the request", "signed id differs from the row's id")
    if type(p.get("sid")) is not int or p["sid"] != conf["SERVER_ID"]:
        raise Refuse("the request was for a different server", "request is for server %r" % (p.get("sid"),))
    site = p.get("host")
    if not isinstance(site, str) or not HOST_RE.match(site) or ".." in site:
        raise Refuse("the server did not accept the request", "host is not a site name")
    iat, exp = p.get("iat"), p.get("exp")
    if type(iat) is not int or type(exp) is not int or exp <= iat or exp - iat > MAX_REQUEST_LIFE:
        raise Refuse("the server did not accept the request", "bad times in the request")
    if exp < now - SKEW:
        raise Refuse("the request ran out of time; try again", "request expired")
    if iat > now + SKEW + 60:
        raise Refuse("the server did not accept the request", "request is dated in the future")
    if iat < STARTED - SKEW:
        raise Refuse("the sign-in service had just restarted; try again", "request predates this start")
    if request_id in seen:
        raise Refuse("the request was already used; try again", "request id seen before")
    seen[request_id] = exp + SKEW + 60
    return request_id, site


def site_user_id(site_dir):
    """The WordPress user GridPane's own SSO signs in as: logs/wpadmin_id.env, else 1."""
    try:
        with open(site_dir + "/logs/wpadmin_id.env") as fh:
            value = "".join(fh.read(64).split())
        if re.match(r"^[1-9][0-9]{0,9}$", value):
            return value
    except OSError:
        pass
    return "1"


def mint(site):
    site_dir = WWW + "/" + site
    if not os.path.isdir(site_dir + "/htdocs") or os.path.islink(site_dir):
        raise Refuse("this site is not on this server", "no site folder for %s" % site)
    try:
        frozen = [n for n in os.listdir(site_dir + "/nginx") if n.endswith("-freeze-main-context.conf")]
    except OSError:
        frozen = []
    if frozen:
        raise Refuse("the site is frozen for a move", "%s is frozen" % site)

    now = time.time()
    while recent and recent[0] < now - 60:
        recent.popleft()
    if len(recent) >= MAX_PER_MINUTE:
        raise Refuse("too many sign-ins on this server in a minute; wait and try again", "own limit reached")
    recent.append(now)

    try:
        p = subprocess.run(
            [GP, "wp", site, "login", "create", site_user_id(site_dir), "--url-only", "--expires=%d" % LINK_LIFE],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=GP_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise Refuse("the server took too long to create a sign-in link", "gp timed out")
    except OSError:
        raise Refuse("the server could not create a sign-in link", "gp could not be run")
    link = None
    for line in p.stdout.decode("utf-8", "replace").splitlines():
        m = LINK_RE.match(line.strip())
        if m:
            host = m.group(1)
            if host == site or host == "www." + site or "www." + host == site:
                link = line.strip()
    if not link:
        raise Refuse("the server could not create a sign-in link", "gp exit %d and no link for this site" % p.returncode)
    return link


def seal(request_id, link):
    p = subprocess.run(
        [OPENSSL, "pkeyutl", "-encrypt", "-pubin", "-inkey", BOX_PUB,
         "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256", "-pkeyopt", "rsa_mgf1_md:sha256"],
        input=(request_id + "\n" + link).encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
    )
    if p.returncode != 0 or len(p.stdout) < 128:
        raise Refuse("the server could not seal the sign-in link", "openssl could not seal (exit %d)" % p.returncode)
    return base64.b64encode(p.stdout).decode("ascii")


def handle(conf, item):
    t0 = time.time()
    request_id, site = None, "?"
    try:
        request_id, site = read_request(conf, item, int(t0))
        sealed = seal(request_id, mint(site))
        accepted = complete(conf, request_id, sealed=sealed)
        log("request %s site %s: %s in %.1fs" % (request_id, site, "sealed link sent" if accepted else "sealed link sent too late, Fleet did not take it", time.time() - t0))
    except Refuse as r:
        rid = request_id or (item.get("id") if isinstance(item, dict) and isinstance(item.get("id"), str) and UUID_RE.match(item.get("id")) else None)
        log("request %s site %s: refused (%s)" % (rid, site, r))
        if rid:
            try:
                complete(conf, rid, error=r.public)
            except Exception as e:
                log("request %s: could not report the refusal (%s)" % (rid, type(e).__name__))


def one_round(conf):
    """Returns how long to wait before the next round."""
    now = time.time()
    for rid in [k for k, v in seen.items() if v < now]:
        del seen[rid]
    answer = poll(conf)
    if not isinstance(answer, dict):
        raise RuntimeError("database gave an answer this service does not understand")
    if not answer.get("enabled"):
        # The database hands out nothing while switched off; this only slows the asking.
        return POLL_OFF
    for item in (answer.get("requests") or [])[:5]:
        handle(conf, item)
    return POLL_ARMED if answer.get("armed") else POLL_IDLE


# ------------------------------------------------------------------------------
# --check: prove the settings without minting anything
# ------------------------------------------------------------------------------
def check(conf):
    ok = True

    def say(good, text):
        nonlocal ok
        ok = ok and good
        log("  %s %s" % ("ok  " if good else "FAIL", text))

    log("server id %d, python %s" % (conf["SERVER_ID"], sys.version.split()[0]))
    try:
        v = subprocess.run([OPENSSL, "version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).stdout.decode().strip()
    except OSError:
        v = ""
    say(bool(v), "openssl runs (%s)" % (v or "not found at %s" % OPENSSL))
    try:
        sealed = seal("00000000-0000-4000-8000-000000000000", "https://check.invalid/check/only")
        say(len(base64.b64decode(sealed)) >= 256, "openssl can seal to Fleet's public key")
    except Refuse as r:
        say(False, "openssl can seal to Fleet's public key (%s)" % r)
    try:
        say(not verify_signature(b"v1.check", b"\0" * 384), "a made-up signature is refused")
    except Exception as e:
        say(False, "the signature check runs (%s)" % type(e).__name__)
    say(os.access(GP, os.X_OK), "gp is at %s" % GP)
    try:
        answer = poll(conf)
        say(isinstance(answer, dict), "Fleet's database accepts this server's token (one-click sign-in is switched %s)" % ("on" if isinstance(answer, dict) and answer.get("enabled") else "off"))
        if isinstance(answer, dict) and answer.get("requests"):
            # A check must not swallow a real request. It was claimed by the poll, so say so.
            for item in answer["requests"]:
                if isinstance(item, dict) and isinstance(item.get("id"), str) and UUID_RE.match(item["id"]):
                    complete(conf, item["id"], error="the sign-in service was being checked; try again")
    except TokenRejected:
        say(False, "Fleet's database accepts this server's token")
    except Exception as e:
        say(False, "Fleet's database can be reached (%s)" % e)
    log("check_result=%s" % ("ok" if ok else "stop"))
    return 0 if ok else 1


def stop(_sig, _frame):
    global stopping
    stopping = True


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("", "--once", "--check"):
        sys.stderr.write("use: fleet-sso-agent [--once | --check]\n")
        return 2
    conf = read_conf()
    if mode == "--check":
        return check(conf)
    if mode == "--once":
        try:
            one_round(conf)
        except TokenRejected:
            log("Fleet's database rejected this server's token")
            return 1
        return 0

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log("started for server %d" % conf["SERVER_ID"])
    failures = 0
    while not stopping:
        try:
            wait = one_round(conf)
            failures = 0
        except TokenRejected:
            # A wrong token will not fix itself. Ask rarely, and say so once per ask.
            log("Fleet's database rejected this server's token; run install-fleet-sso-agent.sh --apply for this server")
            wait = 300.0
        except Exception as e:
            failures += 1
            wait = min(300.0, 15.0 * failures)
            log("could not reach Fleet's database (%s); trying again in %ds" % (type(e).__name__, wait))
        # A little randomness so a whole fleet does not ask in the same second.
        end = time.time() + wait * random.uniform(0.9, 1.1)
        while not stopping and time.time() < end:
            time.sleep(min(0.5, max(0.0, end - time.time())))
    log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
