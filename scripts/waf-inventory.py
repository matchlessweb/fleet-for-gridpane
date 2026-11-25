#!/usr/bin/env python3
"""Inventory the Cloudflare WAF custom rules of every zone a token can read, and
compare each zone against YOUR written standard.

Reads only. It asks Cloudflare for the zone list and, per zone, the custom
rules, the number of rate-limit rules and the DNS records. It changes nothing.

    python3 scripts/waf-inventory.py --out DIR     # writes DIR/report.json
    python3 scripts/waf-inventory.py --selftest    # offline checks, no API calls

scripts/waf-refresh.sh runs it once a day and loads report.json into the app
(scripts/ingest-waf-report.ts). The words used here and in the app (the five
rules, the three profiles, the classes, DNS reach) are explained in
docs/cloudflare-waf-standard.md.

WHAT IT NEEDS

  A Cloudflare API token that can read zones, zone WAF rulesets and DNS. A
  read-only token is enough and is the right one to use. It is looked for in
  this order (the same three places scripts/lib-fleet-token.sh looks):

    1. the environment variable FLEET_CF_TOKEN_ALL_READ
    2. a command of your own, one line in ~/.config/fleet/cloudflare-token-command
       with {name} where the token's name goes; the name asked for is all-read
    3. the file ~/.config/fleet/tokens/cloudflare-all-read.token (chmod 600)

  The token is never printed and never put on a command line: it reaches curl
  on standard input.

WHAT IS OPTIONAL

  Your standard, as a document. The rules to compare against are not built in:
  they are read from a Markdown file you write (the format is in
  docs/cloudflare-waf-standard.md). Name it with --standard, or WAF_STANDARD,
  or put its path on one line in ~/.config/fleet/waf-standard. With none, the
  inventory still lists every zone, rule and DNS finding, but compares nothing:
  every zone that has rules reads as "custom" (not compared), never "standard".

  A page of your own. If WAF_PAGE_TEMPLATE, or one line in
  ~/.config/fleet/waf-page-template, names an HTML file, a copy is written to
  DIR/index.html with the text __DATA__ replaced by the report as JSON. The
  app does not need it.

HOW ZONES ARE COMPARED

Rule 1 is different on every site by design, so it is never compared: its
clauses are listed. Zones are compared BY ROLE, not by position: two zones can
carry the same rules in a different order, and that is not drift.

Rules are only half the question. The script also reads each zone's DNS records
and reports which hostnames are DNS-only (grey cloud), because a rule cannot act
on traffic that never reaches Cloudflare: a zone can carry the whole standard
and still be bypassed at its front door. Origin addresses are replaced with
numbered labels, so the report never lists the addresses that bypass the edge.

Every expression is masked before it reaches the report: any run of 20 or more
word characters becomes "<N-char value redacted>". A rule can match on a key or
a shared secret, so no expression is ever printed or stored unmasked.
"""
import argparse, collections, difflib, hashlib, json, os, re, stat, subprocess, sys, tempfile, time

CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
TOKEN_NAME = "all-read"


def config_dir():
    """Where this machine's settings live: ~/.config/fleet, or under $XDG_CONFIG_HOME."""
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "fleet")


def setting(env, filename):
    """One optional setting: the environment variable, else the first line of
    the settings file of that name, else None."""
    v = (os.environ.get(env) or "").strip()
    if v:
        return v
    try:
        with open(os.path.join(config_dir(), filename)) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
    except OSError:
        pass
    return None


def api_base():
    """Cloudflare's API. WAF_API_BASE points the run at a stand-in for tests,
    and only at this machine: a token is never sent to any other address."""
    v = (os.environ.get("WAF_API_BASE") or "").strip().rstrip("/")
    if not v:
        return CLOUDFLARE_API
    if not re.match(r"^http://127\.0\.0\.1:\d+(/[\w./-]*)?$", v):
        raise SystemExit("WAF_API_BASE is for tests against a stand-in on this machine "
                         "(http://127.0.0.1:<port>). Refusing to send a token anywhere else.")
    return v

# ---------------------------------------------------------------- primitives

def norm(s):
    return re.sub(r"\s+", " ", s).strip()

def mask(s):
    """Replace any long opaque token with its length. Keeps secrets out of the report."""
    return re.sub(r"(?<![\w.])[A-Za-z0-9_\-]{20,}(?![\w.])",
                  lambda m: "<%d-char value redacted>" % len(m.group(0)), s)

def clauses(expr):
    """Split a top-level ' or '-joined list of parenthesised clauses."""
    s = norm(expr); out = []; depth = 0; buf = ""; i = 0
    while i < len(s):
        c = s[i]
        if c == "(": depth += 1
        elif c == ")": depth -= 1
        if depth == 0 and s[i:i + 4] == " or ":
            out.append(buf.strip()); buf = ""; i += 4; continue
        buf += c; i += 1
    if buf.strip(): out.append(buf.strip())
    return out

BLOCK_AFTER_CHALLENGE = ("block rule runs after a challenge: a hosting network that passes the "
                         "challenge is never blocked (s1.4)")


def role_of(action, expr):
    """Which of the five standard rules this is, judged by shape not position."""
    e = norm(expr)
    if action == "skip":  return "skip"
    if action == "block":
        # The dev profile's rule 1 is also a block. Tell it from rule 5 by shape:
        # it names verified-bot categories and carries no ASN list, where rule 5
        # carries both. Guessing by position would break on a reordered zone.
        if "cf.verified_bot_category" in e and "ip.geoip.asnum" not in e:
            return "noindex"
        return "block"
    ua = len(re.findall(r"http\.user_agent contains", e))
    if "ip.geoip.asnum" in e and "ip.geoip.country" in e and ua <= 1: return "providers"
    if ua >= 3: return "crawlers"
    if "wp-login" in e or len(e) < 300: return "vpn"
    return "other"

# Canonical ORDER (s1.4): the block runs second, before every challenge.
ROLES = ["skip", "block", "providers", "crawlers", "vpn"]
LABEL = {"skip": "1. Good Bots Allow (skip)", "providers": "2. MC Providers and Countries",
         "crawlers": "3. MC Aggressive Crawlers", "vpn": "4. MC VPNs and WP Login",
         "block": "5. Block Web Hosts / WP Paths / TOR", "other": "other",
         "noindex": "1. Block Indexing Bots (dev)"}

# Three profiles. A zone is compared against whichever one its SHAPE matches,
# when your standard document describes that profile; a zone that matches none,
# or whose profile you have not written down, is "custom", which means not
# compared, not customized. See docs/cloudflare-waf-standard.md s1 (wordpress),
# s1.2 (static) and s1.3 (dev).
PROFILES = {
    "wordpress": {"roles": ["skip", "block", "providers", "crawlers", "vpn"],
                  "prefix": "Rule", "nums": (2, 3, 4, 5),
                  "label": LABEL},
    "static":    {"roles": ["skip", "block", "other", "crawlers"],
                  "prefix": "Static rule", "nums": (2, 3, 5),
                  "label": dict(LABEL, other="2. MC Providers (static: no country clause)",
                                block="5. Block Hosting Networks / Scanner Paths / TOR")},
    # A dev zone inverts rule 1: it BLOCKS the crawler categories production
    # skips, and has no skip rule at all. Rules 2-5 are the wordpress canon
    # unchanged, so they are inherited rather than repeated in the document.
    "dev":       {"roles": ["noindex", "block", "providers", "crawlers", "vpn"],
                  "prefix": "Dev rule", "nums": (1,), "inherit": "wordpress",
                  "label": LABEL},
}
ROLE_OF_NUM = {1: {"dev": "noindex"},
               2: {"wordpress": "providers", "static": "other"},
               3: {"wordpress": "crawlers",  "static": "crawlers"},
               4: {"wordpress": "vpn"},
               5: {"wordpress": "block",     "static": "block"}}

def standard_path(arg=None):
    """The standard document this run compares against, or None when none is set.
    A document that is named but cannot be read stops the run: comparing against
    nothing would quietly turn every zone into "not compared"."""
    path = arg or setting("WAF_STANDARD", "waf-standard")
    if not path:
        return None
    path = os.path.expanduser(path)
    if not os.path.isfile(path):
        raise SystemExit("the standard document is set to %s, and that file is not there. "
                         "Fix --standard, WAF_STANDARD or %s."
                         % (path, os.path.join(config_dir(), "waf-standard")))
    return path


def _rule_block(doc, prefix, n):
    """The text of the code block under the heading **<prefix> <n>**, or None."""
    m = re.search(r"\*\*%s %d:?\*\*:?[^\n]*\n+```[a-z]*\n(.*?)```"
                  % (re.escape(prefix), n), doc, re.S)
    return (norm(m.group(1)) or None) if m else None


def load_canon(path, profile="wordpress"):
    """One profile's rules verbatim from your standard document, keyed by role.
    {} when the document has none of that profile's rule blocks; a profile that
    is only partly there stops the run, because half a standard compares wrong."""
    doc = open(path).read()
    p = PROFILES[profile]
    found = {n: _rule_block(doc, p["prefix"], n) for n in p["nums"]}
    if not any(found.values()):
        return {}
    for n in p["nums"]:
        if not found[n]:
            raise SystemExit("could not find %s %d in %s" % (p["prefix"], n, path))
    out = {ROLE_OF_NUM[n][profile]: found[n] for n in p["nums"]}
    base = p.get("inherit")
    if base:
        parent = load_canon(path, base)
        if not parent:
            raise SystemExit("%s describes the %s profile, which takes its other rules from the "
                             "%s profile, and that one is not in the document" % (path, profile, base))
        for role in p["roles"]:
            if role not in out and role in parent:
                out[role] = parent[role]
    return out


def load_canons(path):
    """Every profile the document describes, keyed by name. No document: none."""
    if not path:
        return {}
    out = {}
    for k in PROFILES:
        c = load_canon(path, k)
        if c:
            out[k] = c
    return out


def match_profile(roles):
    """Which canon this zone's shape can be compared against, or None."""
    for nm, p in PROFILES.items():
        if sorted(roles) == sorted(p["roles"]):
            return nm
    return None

def lits(s):
    return set(re.findall(r'"([^"]*)"', s)) | set(re.findall(r"\b\d{3,6}\b", s))

def balanced(s):
    """True when every parenthesis in s closes, and none closes early."""
    d = 0
    for c in s:
        if c == "(": d += 1
        elif c == ")":
            d -= 1
            if d < 0: return False
    return d == 0


def unguard(expr):
    """Split a leading per-rule guard: '(not X) and (BODY)' -> ("(not X)", BODY).

    A guard narrows ONE rule so a caller that rule must not catch gets past it
    (docs/cloudflare-waf-standard.md s2, and s1.3 for a whole zone). It wraps
    the entire canon body in one pair of parentheses, so WITHOUT stripping it
    the clause diff sees a single enormous clause and reports every canon clause
    as removed: dozens of findings of pure noise, which is worse than none
    because it hides the real drift it is supposed to surface.

    Returns (None, expr) when there is no guard, so an unguarded rule is
    untouched. The body must be balanced on its own, or the parentheses removed
    were part of a clause rather than a wrapper and nothing is stripped.
    """
    e = norm(expr)
    m = re.match(r"^(\(not\b[^()]*(?:\([^()]*\)[^()]*)*\))\s+and\s+\((.*)\)$", e, re.S)
    if not m:
        return None, e
    guard, body = m.group(1), m.group(2).strip()
    if not balanced(body) or not body:
        return None, e
    return guard, body


def diff_rule(zexpr, cexpr):
    """Human-readable differences between a zone's rule and the standard text."""
    guard, zexpr = unguard(zexpr)
    pre = ["guarded by: " + mask(guard)] if guard else []
    zs = [norm(x) for x in clauses(zexpr)]
    cs = [norm(x) for x in clauses(cexpr)]
    extra   = [x for x in zs if x not in cs]
    missing = [y for y in cs if y not in zs]
    out = []; unpaired = []; used = set()
    for x in extra:
        best, score = None, 0.0
        for j, y in enumerate(missing):
            if j in used: continue
            r = difflib.SequenceMatcher(None, x, y).ratio()
            if r > score: score, best = r, j
        if best is not None and score > 0.75:
            used.add(best); y = missing[best]
            a, b = lits(x) - lits(y), lits(y) - lits(x)
            bits = []
            if a: bits.append("added "   + ", ".join(mask(v) for v in sorted(a)[:14]))
            if b: bits.append("removed " + ", ".join(mask(v) for v in sorted(b)[:14]))
            out.append("list changed: " + "; ".join(bits) if bits else "clause reworded")
        else:
            unpaired.append(x)
    for x in unpaired:
        out.append("extra clause: " + mask(x)[:160])
    for j, y in enumerate(missing):
        if j not in used:
            out.append("clause removed: " + mask(y)[:160])
    return pre + out

# ---------------------------------------------------------------- reachability

PROXIABLE = ("A", "AAAA", "CNAME")

# Third-party platforms that serve a site themselves and are not meant to sit
# behind another proxy, so a grey front-door record pointing at one is expected
# rather than a hole. Proxying such a record would most likely break that
# platform's own certificate.
#
# Why the table exists: without it, a zone whose apex is a site builder's own
# addresses and whose www is a CNAME to that builder reads as a front-door
# bypass, when the only server of yours in the zone is a proxied subdomain that
# is already covered. Proxying that front door would be the wrong fix.
#
# Suffixes match on a dot boundary, so "squarespace.com" never matches
# "notsquarespace.com".
PLATFORM_HOSTS = (
    "squarespace.com", "wixdns.net", "wixsite.com", "myshopify.com",
    "parkingpage.namecheap.com", "registrar-servers.com", "github.io",
    "webflow.io", "netlify.app", "vercel-dns.com", "ghost.io", "kajabi.com",
    "hubspotusercontent.net", "wpenginepowered.com", "squarespace-cdn.com",
)

# Published apex addresses for platforms that offer only A records. Only
# addresses the vendor documents belong here, never one inferred from a single
# sighting: an address this script does not recognize is reported as
# unidentified, which asks for a look, rather than guessed in either direction.
PLATFORM_IPS = (
    # Squarespace's four documented apex A records
    "198.185.159.144", "198.185.159.145", "198.49.23.144", "198.49.23.145",
)

def is_platform(content):
    """True when this record points at a third-party platform's own front end."""
    c = (content or "").lower().rstrip(".")
    if c in PLATFORM_IPS:
        return True
    return any(c == h or c.endswith("." + h) for h in PLATFORM_HOSTS)

def dns_classify(zone, records, origins, proxied_ips=(), zone_proxied=()):
    """Which hostnames in this zone bypass Cloudflare entirely.

    A custom rule can only act on traffic that reaches Cloudflare, so a
    grey-cloud (DNS-only) record is a hole no ruleset can close: not a custom
    rule, not Managed Rules, not Bot Fight Mode, not an IP Access Rule. A zone
    can carry the complete standard and still be wide open at the front door:
    it reads as "standard" while every request goes straight to the origin.

    Only A/AAAA/CNAME can be proxied at all, so every other record type is
    excluded by type rather than counted as a hole.

    Grey records are not all the same thing. Counted together they flag most
    zones, which is noise rather than signal. Three buckets, because they need
    three different responses:

      front     the apex or www is grey. The site itself bypasses its own rules.
                Always a bypass, whatever the record points at.
      origin    a non-front record that exposes a server: an A/AAAA, or a CNAME
                pointing back inside the zone. A GridPane "staging.<zone>" A
                record is the usual case. Fix by locking the origin to
                Cloudflare's ranges at the host firewall, or by deleting a
                vestigial record.
      delegated a non-front CNAME pointing outside the zone - pm-bounces to
                Postmark, _domainkey, autodiscover/lyncdiscover/sip to
                Microsoft, a CDN host. These cannot be proxied and expose no
                origin of yours, so they are counted, not listed as holes.

    A grey front door is not by itself a problem: most of the ones a plain
    check reports belong to someone else's platform. So each grey record also
    carries what is on the other end:

      platform      a third-party front end (Squarespace, Wix, a parking page).
                    Expected to be grey. Proxying it would break its own
                    certificate. Not a finding.
      inzone        a CNAME pointing at a name in this zone that IS proxied.
                    Cloudflare flattens it to the origin address, so the record
                    bypasses the edge even though its target is orange. The most
                    actionable class: a one-record flip, no cert risk, because
                    the same origin already serves the proxied name.
      ours          an A/AAAA whose address is also the content of a PROXIED
                    A/AAAA in any zone this run reads, which is how it is known
                    to be an origin you put behind Cloudflare yourself.
                    Actionable.
      unidentified  anything else. Reported as needing a look rather than
                    guessed, because this script reads the Cloudflare API only
                    and never probes a site. Resolving one means a live request
                    by hand: a third-party `server:` header, or a dead host.

    Only the content of a proxied A/AAAA joins the set of your origins. A
    proxied CNAME's content is a hostname, not an origin, and counting those
    makes a `www` pointing at a registrar's parking page read as one of yours
    as soon as some other zone proxies a parking page too.

    Origin addresses never reach the report. Each exposed one gets a number
    that is the same across every zone in the run, so a shared origin stays
    visible without the report carrying a list of targets that bypass the edge.
    """
    apex, www = zone, "www." + zone
    suffix = "." + zone
    grey, front_total, front_grey, delegated = [], 0, 0, 0
    proxied_names = set()
    for r in records:
        typ = r.get("type")
        if typ not in PROXIABLE:
            continue
        name = r.get("name")
        front = name in (apex, www)
        if front:
            front_total += 1
        if r.get("proxied"):
            # Names only, never targets: a consumer can then say "this hostname
            # is proxied" from evidence instead of from its absence in `grey`
            # (absent also means delegated, or no record at all).
            if name:
                proxied_names.add(name.lower())
            continue
        c = r.get("content") or ""
        inside = (c == zone or c.endswith(suffix))
        if not front and typ == "CNAME" and not inside:
            delegated += 1
            continue
        if c not in origins:
            origins[c] = len(origins) + 1
        if is_platform(c):
            cls = "platform"
        elif typ == "CNAME" and inside and c in zone_proxied:
            cls = "inzone"
        elif typ in ("A", "AAAA") and c.lower() in proxied_ips:
            cls = "ours"
        else:
            cls = "unidentified"
        grey.append({"name": name, "type": typ, "front": front,
                     "cls": cls, "origin": origins[c]})
        if front:
            front_grey += 1
    fc = [g["cls"] for g in grey if g["front"]]
    if front_total == 0:
        reach = "no-site"
    elif not fc:
        reach = "proxied"
    elif any(x in ("ours", "inzone") for x in fc):
        reach = "bypass"
    elif "unidentified" in fc:
        reach = "review"
    else:
        reach = "platform-front"
    return {"reach": reach, "grey": grey, "grey_front": front_grey,
            "grey_other": len(grey) - front_grey, "delegated": delegated,
            "front_classes": dict(collections.Counter(fc)),
            "proxied_names": sorted(proxied_names)}

# ---------------------------------------------------------------- fetching

TOKEN_VALUE = re.compile(r"^[A-Za-z0-9._~+/=-]+$")


def cf_token(name=TOKEN_NAME):
    """The Cloudflare API token called <name>, from the first place that is set:

      1. the environment variable FLEET_CF_TOKEN_<NAME>
      2. a command of your own, on one line in ~/.config/fleet/cloudflare-token-command
      3. the file ~/.config/fleet/tokens/cloudflare-<name>.token, mode 600

    The same order, files and checks as scripts/lib-fleet-token.sh: change one,
    change both. The first place that is set is the one used; if it does not
    work the run stops rather than trying the next. The value is returned, never
    printed, and every message says where a value came from, not what it was.
    """
    if not re.match(r"^[a-z0-9][a-z0-9.-]{0,62}$", name or ""):
        raise SystemExit('ABORT: "%s" is not a token name (lower-case letters, digits, dots and hyphens).' % name)
    env = "FLEET_CF_TOKEN_" + re.sub(r"[^A-Z0-9]", "_", name.upper())
    cmdfile = os.path.join(config_dir(), "cloudflare-token-command")
    tokfile = os.path.join(config_dir(), "tokens", "cloudflare-%s.token" % name)
    line = ""
    try:
        with open(cmdfile) as f:
            for row in f:
                row = row.strip()
                if row and not row.startswith("#"):
                    line = row
                    break
    except OSError:
        pass

    if os.environ.get(env):
        src, val = "the environment variable " + env, os.environ[env]
    elif line:
        src = "the command in " + cmdfile
        st = os.stat(cmdfile)
        if st.st_uid != os.geteuid() or st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise SystemExit("ABORT: %s names a command this script would run, and someone else can change it.\n"
                             '       Make it yours alone: chmod 600 "%s"' % (cmdfile, cmdfile))
        # Split on spaces only: nothing in the line is expanded or run by a shell.
        argv = [w.replace("{name}", name) for w in line.split()]
        try:
            r = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
        except OSError:
            raise SystemExit('ABORT: the token command "%s" (from %s) is not on the PATH.' % (argv[0], cmdfile))
        if r.returncode != 0:
            raise SystemExit("ABORT: the token command failed (exit %d):  %s\n"
                             "       It comes from %s. Nothing else was tried."
                             % (r.returncode, " ".join(argv), cmdfile))
        val = r.stdout
    elif os.path.exists(tokfile):
        src = "the file " + tokfile
        try:
            st = os.stat(tokfile)
            ok = stat.S_ISREG(st.st_mode) and not st.st_mode & (stat.S_IRWXG | stat.S_IRWXO)
            mode = stat.filemode(st.st_mode)
            val = open(tokfile).read() if ok else ""
        except OSError:
            ok, mode, val = False, "unreadable", ""
        if not ok:
            raise SystemExit("ABORT: %s must be a file only you can read (it is %s).\n"
                             '       Fix it with: chmod 600 "%s"' % (tokfile, mode, tokfile))
    else:
        raise SystemExit(
            'ABORT: no Cloudflare token "%s" is set up on this machine.\n'
            "       Set ONE of these (the first one found is used):\n"
            "         1. the environment variable %s\n"
            "         2. a command that prints the token, on one line in %s\n"
            "            with {name} where the token's name goes, for example:  pass show cloudflare/{name}\n"
            "         3. the token alone in the file %s  (then: chmod 600 that file)"
            % (name, env, cmdfile, tokfile))

    val = val.rstrip("\n").rstrip("\r")
    if not TOKEN_VALUE.match(val):
        if not val:
            raise SystemExit("ABORT: %s gave an empty value, not a token." % src)
        raise SystemExit("ABORT: %s gave %d characters that are not one API token (a space, a quote, "
                         "a line break or another character no token has)." % (src, len(val)))
    return val

FETCH_TRIES = 4

def _curl(tok, path):
    """One request. Returns (http status as text, body text); ("000", "") when curl itself failed.
    The token goes to curl on standard input (-H @-), never on its command line,
    where `ps` would show it to every user of this machine."""
    out = subprocess.run(["curl", "-s", "--max-time", "30", "-w", "\n%{http_code}",
                          "-H", "@-", api_base() + path],
                         input="Authorization: Bearer " + tok + "\n",
                         capture_output=True, text=True).stdout
    body, _, code = out.rpartition("\n")
    return (code.strip() or "000"), body

def _parse(code, body):
    try:
        d = json.loads(body)
        if not isinstance(d, dict): raise ValueError
    except Exception:
        d = {"success": False, "errors": [{"message": "unparseable response"}], "_unparseable": True}
    d["_http"] = code
    return d

def transient(d):
    """A failure worth asking again about: no answer, rate limited, or a server error."""
    if d.get("success"): return False
    code = str(d.get("_http", "000"))
    return bool(d.get("_unparseable")) or code in ("000", "429") or code.startswith("5")

def absent(d):
    """Cloudflare's own "this zone has no ruleset in that phase": 404 with error 10003.
    The ONLY failure that means "no rules": a zone without a ruleset answers
    exactly this, for both phases the sweep reads."""
    return (not d.get("success") and str(d.get("_http")) == "404"
            and any(e.get("code") == 10003 for e in d.get("errors") or []))

def fetch(tok, path, tries=FETCH_TRIES, call=_curl, sleep=time.sleep):
    """GET with retries. A transient failure is asked again (1s, 2s, 4s apart; 10s
    after a 429). Anything else, a definite answer of either kind, returns at once."""
    d = {}
    for n in range(tries):
        d = _parse(*call(tok, path))
        if not transient(d): return d
        if n < tries - 1:
            sleep(10 if str(d.get("_http")) == "429" else 2 ** n)
    return d

def unread(what, name, d):
    """Stop the whole run. If a failed ruleset read were recorded as "no rules",
    one dropped request would make a protected zone look unprotected in the
    report. A report with a hole in it is worse than no report, so the run fails
    and the previous report stands."""
    codes = ", ".join(str(e.get("code") or e.get("message")) for e in d.get("errors") or []) or "no detail"
    raise SystemExit("could not read %s for %s (HTTP %s; %s) after %d tries. "
                     "No report written: a zone that cannot be read is not a zone with no rules."
                     % (what, name, d.get("_http"), codes, FETCH_TRIES))

DNS_PAGE = 500        # records asked for per request
DNS_MAX_PAGES = 400   # a zone that needs more requests than this is not being read properly

def dns_records(tok, zid):
    """Every DNS record of a zone, from as many pages as it takes, or None.

    None means "could not be read", and the zone's reach is then reported as
    unknown. A list is only ever the WHOLE list: if any page fails, or fewer
    records arrive than Cloudflare says there are, the answer is None. A
    grey-clouded apex on a page that was never read would otherwise let an
    unprotected zone read as proxied.

    When to stop asking. Cloudflare sends a count with each page (result_info).
    That count ends the list only after a page that came back short of a full
    one, and only when it agrees with what has arrived. After a full page the
    next one is always asked for, and without an agreeing count the list ends at
    an empty page. So a missing or odd result_info can cost one more request,
    and can never end the list early."""
    out, total = [], None
    for page in range(1, DNS_MAX_PAGES + 1):
        d = fetch(tok, "/zones/%s/dns_records?per_page=%d&page=%d" % (zid, DNS_PAGE, page))
        got = d.get("result")
        if not d.get("success") or not isinstance(got, list):
            return None
        out += got
        ri = d.get("result_info")
        said = ri.get("total_count") if isinstance(ri, dict) else None
        if isinstance(said, int) and not isinstance(said, bool):
            total = said                     # the latest count Cloudflare gave
        if not got:
            # The end. If Cloudflare counted more records than arrived, the list
            # has a hole in it, and a list with a hole is not handed on.
            return None if total is not None and total > len(out) else out
        if len(got) < DNS_PAGE and total == len(out):
            return out
    return None

ZONE_PAGE = 50        # zones asked for per request
ZONE_MAX_PAGES = 400  # an account that needs more requests than this is not being read properly

def zone_list(tok):
    """Every zone the token can see, from as many pages as it takes.

    The same rule as dns_records: Cloudflare's count ends the list only after a
    page that came back short of a full one, and only when it agrees with what
    has arrived; otherwise the list ends at an empty page. A missing or odd
    result_info can cost one more request and can never end the list early. A
    zone that was never listed would be a zone nobody checks. Any failed page,
    or fewer zones than Cloudflare counted, stops the run with no report."""
    zones, total = [], None
    for page in range(1, ZONE_MAX_PAGES + 1):
        d = fetch(tok, "/zones?per_page=%d&page=%d" % (ZONE_PAGE, page))
        got = d.get("result")
        if not d.get("success") or not isinstance(got, list):
            raise SystemExit("zone list failed: %s" % d.get("errors"))
        zones += got
        ri = d.get("result_info")
        said = ri.get("total_count") if isinstance(ri, dict) else None
        if isinstance(said, int) and not isinstance(said, bool):
            total = said
        if not got:
            if total is not None and total > len(zones):
                raise SystemExit("zone list failed: Cloudflare counted %d zones and listed %d" % (total, len(zones)))
            return zones
        if len(got) < ZONE_PAGE and total == len(zones):
            return zones
    raise SystemExit("zone list failed: no end after %d pages" % ZONE_MAX_PAGES)

def sweep(tok, verbose=True):
    zones = zone_list(tok)
    if verbose: print("zones visible: %d" % len(zones))
    raw = {}
    for i, z in enumerate(zones, 1):
        zid, name = z["id"], z["name"]
        rec = {"zone": zid, "plan": (z.get("plan") or {}).get("name"),
               "acct": (z.get("account") or {}).get("name"), "paused": z.get("paused")}
        d = fetch(tok, "/zones/%s/rulesets/phases/http_request_firewall_custom/entrypoint" % zid)
        if absent(d):
            rec.update(status="no-entrypoint", rules=[])
        elif not d.get("success"):
            unread("the custom rules", name, d)
        else:
            r = d["result"]
            rec.update(status="ok", ruleset=r["id"], version=r.get("version"),
                       last_updated=r.get("last_updated"),
                       rules=[{"id": x["id"], "desc": x.get("description") or "",
                               "action": x["action"], "enabled": x.get("enabled", True),
                               "expr": x["expression"], "ap": x.get("action_parameters") or {}}
                              for x in r.get("rules", [])])
        rl = fetch(tok, "/zones/%s/rulesets/phases/http_ratelimit/entrypoint" % zid)
        if not rl.get("success") and not absent(rl):
            unread("the rate-limit rules", name, rl)
        rec["ratelimit_rules"] = len((rl.get("result") or {}).get("rules") or []) if rl.get("success") else 0
        rec["dns"] = dns_records(tok, zid)
        raw[name] = rec
        if verbose and i % 10 == 0: print("  %d/%d" % (i, len(zones)))
        time.sleep(0.04)
    return raw

# ---------------------------------------------------------------- analysis

def analyse(raw, canon, origins=None):
    """`canon` is either {profile: {role: expr}} or a single wordpress canon."""
    origins = {} if origins is None else origins
    canons = canon if set(canon) <= set(PROFILES) else {"wordpress": canon}
    # A first pass over every zone: every address you have deliberately put
    # behind Cloudflare, and the proxied hostnames of each zone. Both are needed
    # to tell one of your own origins from a third-party front end, and neither
    # can be known from one zone alone.
    proxied_ips, zone_proxied = set(), {}
    for zname, zv in raw.items():
        names = set()
        for r in (zv.get("dns") or []):
            if not r.get("proxied"):
                continue
            names.add(r.get("name"))
            if r.get("type") in ("A", "AAAA"):
                proxied_ips.add((r.get("content") or "").lower())
        zone_proxied[zname] = names
    report = {}
    for name, v in sorted(raw.items()):
        rec = {"zone_id": v["zone"], "plan": v.get("plan"), "acct": v.get("acct"),
               "paused": v.get("paused"), "ratelimit_rules": v.get("ratelimit_rules", 0),
               "version": v.get("version"), "updated": (v.get("last_updated") or "")[:10],
               "nrules": len(v.get("rules", []))}
        dns = v.get("dns")
        rec["reach"] = (dns_classify(name, dns, origins, proxied_ips,
                                     zone_proxied.get(name, set()))
                        if dns is not None else
                        {"reach": "unknown", "grey": [], "grey_front": 0,
                         "grey_other": 0, "delegated": 0, "front_classes": {}})
        if v["status"] != "ok" or not v["rules"]:
            rec.update(klass="none", rules=[], findings=[], core_fp=None, order_matches=True)
            report[name] = rec; continue
        rules = v["rules"]
        roles = [role_of(r["action"], r["expr"]) for r in rules]
        # Compare against whichever profile this zone's SHAPE matches, when your
        # standard document describes it. "custom" means "not compared": the
        # shape matches no profile, or the profile it matches is not written
        # down. A zone is never "standard" on the strength of its shape alone.
        shape = match_profile(roles)
        prof = shape if canons.get(shape) else None
        canon = canons.get(prof) or {}
        labels = PROFILES[prof]["label"] if prof else LABEL
        prof_roles = PROFILES[prof]["roles"] if prof else ROLES
        comparable = prof is not None
        rec["comparable"] = comparable
        rec["profile"] = prof
        rec["order"] = [labels[x] for x in roles]
        findings, rlist = [], []
        for r, role in zip(rules, roles):
            # EVERY rule carries its whole expression and its clause list, both
            # masked, so the app can show the exact text to copy for any rule in
            # any zone, not just rule 1. mask() is what makes that safe to store:
            # a rule can match on a key, so an unfiltered expression must never
            # reach the report. `expr_masked` is True when masking actually
            # changed the text, so the app can say that THAT expression will not
            # paste back as-is instead of implying every rule is verbatim.
            full = mask(norm(r["expr"]))
            item = {"desc": r["desc"], "action": r["action"], "enabled": r["enabled"],
                    "role": role, "chars": len(norm(r["expr"])),
                    "expr": full, "expr_masked": full != norm(r["expr"]),
                    "clauses": [mask(c) for c in clauses(r["expr"])]}
            if role == "skip":
                ap = r.get("ap") or {}
                item["skip_scope"] = {"ruleset": ap.get("ruleset"),
                                      "phases": ap.get("phases") or [],
                                      "products": ap.get("products") or []}
            if comparable and role in canon:
                item["diff"] = diff_rule(r["expr"], canon[role])
                findings += ["%s: %s" % (labels[role], x) for x in item["diff"]]
            if not r["enabled"]:
                findings.append("rule “%s” is DISABLED" % r["desc"])
            rlist.append(item)
        # s1.4: a request that passes a challenge is let in and later rules never run,
        # so a block rule placed after any challenge never blocks a hosting network that
        # solves it. That is a defect, not a cosmetic reorder: report it on every zone.
        CHALLENGES = ("managed_challenge", "challenge", "js_challenge")
        first_ch = next((i for i, r in enumerate(rules)
                         if r["enabled"] and r["action"] in CHALLENGES), None)
        if first_ch is not None and any(
                roles[i] == "block" and r["enabled"] and i > first_ch
                for i, r in enumerate(rules)):
            findings.append(BLOCK_AFTER_CHALLENGE)
        if not comparable:
            # Report against the profile it comes closest to, so "missing" is
            # meaningful rather than always measured against the five-rule set.
            # Prefer a profile that CONTAINS every role the zone has, smallest
            # first: a static zone missing rule 2 is nearest the static profile,
            # not the five-rule one, even though both overlap by three roles.
            holds = [k for k in PROFILES if set(roles) <= set(PROFILES[k]["roles"])]
            near = (min(holds, key=lambda k: len(PROFILES[k]["roles"])) if holds else
                    max(PROFILES, key=lambda k: len(set(PROFILES[k]["roles"]) & set(roles))))
            for role in PROFILES[near]["roles"]:
                if role not in roles:
                    findings.append("missing %s" % PROFILES[near]["label"][role])
            rec["nearest"] = near
        core = "|".join(norm(r["expr"]) for r, ro in sorted(zip(rules, roles), key=lambda t: t[1])
                        if ro != "skip")
        rec.update(rules=rlist, findings=findings,
                   order_matches=(roles == prof_roles),
                   core_fp=hashlib.sha256(core.encode()).hexdigest()[:8])
        if comparable and not findings:
            rec["klass"] = "standard" if roles == prof_roles else "standard-reordered"
        elif comparable:
            rec["klass"] = "variant"
        else:
            rec["klass"] = "custom"
        report[name] = rec
    return report

# ---------------------------------------------------------------- selftest

# A made-up standard for the self-test, in the format the script reads. The
# network numbers are the ones kept for documentation and the crawler names are
# invented: it shows the shape of a standard, it is not one to deploy.
SAMPLE_STANDARD = """
# A sample standard (made-up values)

**Rule 2:** managed challenge, providers and countries
```
(not ip.geoip.country in {"US" "CA" "GB"} and not cf.client.bot) or (ip.geoip.asnum in {64496 64497 64498 64499 64500 64501} and not cf.client.bot)
```

**Rule 3:** managed challenge, aggressive crawlers
```
(http.user_agent contains "examplebot") or (http.user_agent contains "samplecrawler") or (http.user_agent contains "testspider") or (http.user_agent contains "demoscraper")
```

**Rule 4:** managed challenge, VPNs and the WordPress login
```
(http.request.uri.path contains "/wp-login.php" and not ip.geoip.country in {"US" "CA" "GB"}) or (cf.threat_score gt 20 and http.request.uri.path contains "/wp-admin")
```

**Rule 5:** block
```
(ip.geoip.asnum in {64502 64503 64504 64505}) or (http.request.uri.path contains "/xmlrpc.php") or (http.request.uri.path contains "/wp-config") or (ip.geoip.country in {"T1"})
```

**Static rule 2:** managed challenge, providers (no country clause)
```
(ip.geoip.asnum in {64496 64497 64498 64499 64500 64501 64502 64503 64504 64505 64506 64507 64508 64509 64510 64511} and not cf.client.bot) or (ip.geoip.asnum in {65536 65537 65538 65539 65540 65541 65542 65543 65544 65545 65546 65547 65548 65549 65550 65551} and not cf.client.bot and not http.request.uri.path eq "/robots.txt")
```

**Static rule 3:** managed challenge, aggressive crawlers
```
(http.user_agent contains "examplebot") or (http.user_agent contains "samplecrawler") or (http.user_agent contains "testspider") or (http.user_agent contains "demoscraper")
```

**Static rule 5:** block
```
(ip.geoip.asnum in {64502 64503 64504 64505}) or (http.request.uri.path contains ".php") or (http.request.uri.path contains "/wp-") or (ip.geoip.country in {"T1"})
```

**Dev rule 1:** block indexing bots
```
(cf.verified_bot_category in {"Search Engine Crawler" "Search Engine Optimization" "AI Crawler" "AI Search" "Archiver"})
```
"""


def selftest():
    """Offline checks. The standard they compare against is SAMPLE_STANDARD,
    written to a temporary file, so they need no document of yours."""
    with tempfile.TemporaryDirectory() as tmp:
        sample = os.path.join(tmp, "standard.md")
        with open(sample, "w") as f:
            f.write(SAMPLE_STANDARD)
        return _selftest(sample, tmp)


def _selftest(SAMPLE, TMP):
    fails = []
    def check(label, cond):
        print(("  PASS  " if cond else "  FAIL  ") + label)
        if not cond: fails.append(label)

    print("reading Cloudflare: a failed read is never \"no rules\"")
    NO_RULESET = ("404", json.dumps({"success": False, "errors": [{"code": 10003, "message": "could not find entrypoint ruleset"}]}))
    OK = ("200", json.dumps({"success": True, "result": {"rules": [1, 2]}}))
    def script(*answers):
        left = list(answers); calls = []
        def call(tok, path):
            calls.append(path); return left.pop(0)
        return call, calls
    naps = []
    c, calls = script(("000", ""), ("502", "<html>bad gateway</html>"), OK)
    d = fetch("t", "/x", call=c, sleep=naps.append)
    check("a dropped request and a 502 are asked again, and the third answer is used",
          d.get("success") is True and len(calls) == 3 and naps == [1, 2])
    naps = []
    c, calls = script(("429", json.dumps({"success": False, "errors": [{"code": 10000}]})), OK)
    check("a rate limit waits longer before asking again",
          fetch("t", "/x", call=c, sleep=naps.append).get("success") is True and naps == [10])
    c, calls = script(NO_RULESET, OK)
    d = fetch("t", "/x", call=c, sleep=naps.append)
    check("\"no ruleset\" is a definite answer: not retried, and counted as absent",
          len(calls) == 1 and absent(d) and not transient(d))
    c, calls = script(*[("000", "")] * FETCH_TRIES)
    d = fetch("t", "/x", call=c, sleep=lambda s: None)
    check("CONTROL a read that never answers is NOT absent (the old code called this no rules)",
          len(calls) == FETCH_TRIES and not d.get("success") and not absent(d))
    check("CONTROL a 404 without error 10003 is not absent",
          not absent(_parse("404", json.dumps({"success": False, "errors": [{"code": 7003}]}))))
    check("CONTROL a 403 is not absent and not retried",
          (lambda d: not absent(d) and not transient(d))(_parse("403", json.dumps({"success": False, "errors": [{"code": 9109}]}))))
    try:
        unread("the custom rules", "example.com", d); stopped = ""
    except SystemExit as e:
        stopped = str(e)
    check("an unreadable zone stops the run and names the zone",
          "example.com" in stopped and "No report written" in stopped)
    real_fetch = globals()["fetch"]
    def fake_fetch(answers):
        def f(tok, path):
            for key, val in answers:
                if key in path: return _parse(*val)
            return _parse(*OK)
        return f
    ZL = ("200", json.dumps({"success": True, "result": [{"id": "zid", "name": "example.com"}],
                             "result_info": {"per_page": 50, "total_count": 1}}))
    DNS = ("200", json.dumps({"success": True, "result": []}))
    try:
        globals()["fetch"] = fake_fetch([("/zones?", ZL), ("firewall_custom", NO_RULESET), ("ratelimit", NO_RULESET), ("dns_records", DNS)])
        raw = sweep("t", verbose=False)
        check("sweep: a zone Cloudflare says has no ruleset is recorded as no-entrypoint",
              raw["example.com"]["status"] == "no-entrypoint" and raw["example.com"]["ratelimit_rules"] == 0)
        globals()["fetch"] = fake_fetch([("/zones?", ZL), ("firewall_custom", ("000", "")), ("ratelimit", NO_RULESET), ("dns_records", DNS)])
        try:
            sweep("t", verbose=False); out = "returned a report"
        except SystemExit as e:
            out = str(e)
        check("CONTROL sweep: a failed rules read stops the run instead of reporting no rules",
              "could not read the custom rules for example.com" in out)
        globals()["fetch"] = fake_fetch([("/zones?", ZL), ("firewall_custom", NO_RULESET), ("ratelimit", ("503", "")), ("dns_records", DNS)])
        try:
            sweep("t", verbose=False); out = "returned a report"
        except SystemExit as e:
            out = str(e)
        check("CONTROL sweep: a failed rate-limit read stops the run too",
              "could not read the rate-limit rules for example.com" in out)

        # A zone's DNS records come a page at a time. One made-up zone: 500
        # proxied names fill the first page, and the apex, grey, is on the second.
        def recs(n, proxied=True, first=0):
            return [{"name": "h%d.example.com" % i, "type": "A", "proxied": proxied, "content": "192.0.2.4"}
                    for i in range(first, first + n)]
        APEX = {"name": "example.com", "type": "A", "proxied": False, "content": "192.0.2.4"}
        def pg(records, total="leave out"):
            body = {"success": True, "result": records}
            if total != "leave out": body["result_info"] = {"per_page": DNS_PAGE, "total_count": total}
            return ("200", json.dumps(body))
        def dns_pages(*answers):
            """Stands in for fetch: answers a zone's DNS pages in turn, then empty pages."""
            asked = []
            def f(tok, path):
                asked.append(path)
                n = int(path.rsplit("page=", 1)[1])
                return _parse(*(answers[n - 1] if n <= len(answers) else pg([])))
            globals()["fetch"] = f
            return asked
        FULL = [{"name": "www.example.com", "type": "CNAME", "proxied": True, "content": "example.com"}] + recs(DNS_PAGE - 1)
        def reach_of(dns):
            return analyse({"example.com": {"zone": "zid", "status": "no-entrypoint", "rules": [], "dns": dns}},
                           {})["example.com"]["reach"]["reach"]
        asked = dns_pages(pg(FULL, DNS_PAGE + 1), pg([APEX], DNS_PAGE + 1))
        got = dns_records("t", "zid")
        check("DNS: a grey apex on the second page is read, and the zone is reported as bypassed",
              got is not None and len(got) == DNS_PAGE + 1 and len(asked) == 2
              and "page=1" in asked[0] and "page=2" in asked[1] and reach_of(got) == "bypass")
        check("CONTROL DNS: the first page alone would have read as proxied", reach_of(FULL) == "proxied")
        asked = dns_pages(pg(FULL, DNS_PAGE + 1), ("403", json.dumps({"success": False, "errors": [{"code": 9109}]})))
        got = dns_records("t", "zid")
        check("DNS: a second page Cloudflare refuses is a failed read, not a list of the first page",
              got is None and len(asked) == 2 and reach_of(got) == "unknown")
        asked = dns_pages(pg(FULL, DNS_PAGE + 1), ("000", ""))
        check("DNS: a second page that never answers is a failed read too", dns_records("t", "zid") is None)
        asked = dns_pages(pg(FULL, DNS_PAGE + 1), ("200", json.dumps({"success": True, "result": None})))
        check("DNS: a second page with no list in it is a failed read", dns_records("t", "zid") is None)
        asked = dns_pages(pg(FULL), pg([APEX]))
        got = dns_records("t", "zid")
        check("DNS: a full page with no count is not the end: the next page is asked for",
              got is not None and len(got) == DNS_PAGE + 1 and len(asked) == 3)
        for label, total in (("of 0", 0), ("that says this page is all there is", DNS_PAGE), ("that is not a number", "501")):
            asked = dns_pages(pg(FULL, total), pg([APEX], total))
            got = dns_records("t", "zid")
            check("DNS: a full page with a count %s is not the end either" % label,
                  got is not None and len(got) == DNS_PAGE + 1 and APEX in got)
        asked = dns_pages(pg(FULL, DNS_PAGE + 100), pg([APEX], DNS_PAGE + 100))
        check("DNS: fewer records than Cloudflare counted is a failed read, not a short list",
              dns_records("t", "zid") is None and len(asked) == 3)
        asked = dns_pages(pg(recs(3), 3))
        got = dns_records("t", "zid")
        check("DNS: a small zone is one request", got is not None and len(got) == 3 and len(asked) == 1)
        asked = dns_pages(pg([], 0))
        check("DNS: a zone with no records is one request, and an empty list (not a failed read)",
              dns_records("t", "zid") == [] and len(asked) == 1)
        asked = dns_pages(pg(recs(100), 250), pg(recs(100, first=100), 250), pg(recs(50, first=200), 250))
        got = dns_records("t", "zid")
        check("DNS: pages smaller than asked for are followed until the count is reached",
              got is not None and len(got) == 250 and len(asked) == 3)
        asked = dns_pages(*[pg(FULL)] * (DNS_MAX_PAGES + 5))
        check("DNS: full pages without end are a failed read after %d requests" % DNS_MAX_PAGES,
              dns_records("t", "zid") is None and len(asked) == DNS_MAX_PAGES)
        dns_pages(pg(FULL, DNS_PAGE + 1), pg([APEX], DNS_PAGE + 1))
        paged = globals()["fetch"]
        def whole_zone(tok, path):
            if "dns_records" in path: return paged(tok, path)
            return _parse(*(ZL if "/zones?" in path else NO_RULESET))
        globals()["fetch"] = whole_zone
        raw = sweep("t", verbose=False)
        check("sweep: the zone's record list is every page",
              len(raw["example.com"]["dns"]) == DNS_PAGE + 1 and APEX in raw["example.com"]["dns"])
        dns_pages(pg(FULL, DNS_PAGE + 1), ("503", ""))
        paged = globals()["fetch"]
        globals()["fetch"] = lambda tok, path: paged(tok, path) if "dns_records" in path else _parse(*(ZL if "/zones?" in path else NO_RULESET))
        raw = sweep("t", verbose=False)
        check("sweep: a zone whose second page failed has no record list at all",
              raw["example.com"]["dns"] is None)

        # The zone list comes a page at a time too. A made-up account of 51 zones.
        def zl(names, total="leave out"):
            body = {"success": True, "result": [{"id": "z-" + n, "name": n} for n in names]}
            if total != "leave out": body["result_info"] = {"per_page": ZONE_PAGE, "total_count": total}
            return ("200", json.dumps(body))
        def zone_pages(*answers):
            asked = []
            def f(tok, path):
                asked.append(path)
                n = int(path.rsplit("page=", 1)[1])
                return _parse(*(answers[n - 1] if n <= len(answers) else zl([])))
            globals()["fetch"] = f
            return asked
        FIFTY = ["z%02d.example" % i for i in range(ZONE_PAGE)]
        def listed(*answers):
            asked = zone_pages(*answers)
            try: return [z["name"] for z in zone_list("t")], asked
            except SystemExit as e: return str(e), asked
        got, asked = listed(zl(FIFTY, ZONE_PAGE + 1), zl(["last.example"], ZONE_PAGE + 1))
        check("zones: the 51st zone, on the second page, is listed", got == FIFTY + ["last.example"] and len(asked) == 2)
        got, asked = listed(zl(FIFTY), zl(["last.example"]))
        check("zones: a full page with no count is not the end: the next page is asked for",
              got == FIFTY + ["last.example"] and len(asked) == 3)
        for label, total in (("of 0", 0), ("that says this page is all there is", ZONE_PAGE), ("that is not a number", "51")):
            got, asked = listed(zl(FIFTY, total), zl(["last.example"], total))
            check("zones: a full page with a count %s is not the end either" % label, got == FIFTY + ["last.example"])
        got, asked = listed(zl(FIFTY, ZONE_PAGE + 1), ("503", ""))
        check("zones: a second page that fails stops the run", isinstance(got, str) and "zone list failed" in got)
        got, asked = listed(zl(FIFTY, ZONE_PAGE + 30), zl(["last.example"], ZONE_PAGE + 30))
        check("zones: fewer zones than Cloudflare counted stops the run, not a short list",
              isinstance(got, str) and "counted 80 zones and listed 51" in got)
        got, asked = listed(zl(["a.example", "b.example"], 2))
        check("zones: a small account is one request", got == ["a.example", "b.example"] and len(asked) == 1)
        got, asked = listed(*[zl(FIFTY)] * (ZONE_MAX_PAGES + 5))
        check("zones: full pages without end stop the run after %d requests" % ZONE_MAX_PAGES,
              isinstance(got, str) and "no end after" in got and len(asked) == ZONE_MAX_PAGES)
    finally:
        globals()["fetch"] = real_fetch

    print("clause splitting")
    check("splits three top-level clauses",
          clauses('(a eq 1) or (b eq 2) or (c eq 3)') == ['(a eq 1)', '(b eq 2)', '(c eq 3)'])
    check("does not split ' or ' nested inside parentheses",
          clauses('(a eq 1 or b eq 2) or (c eq 3)') == ['(a eq 1 or b eq 2)', '(c eq 3)'])

    print("masking")
    check("masks a credential-shaped literal",
          "PLACEHOLDER" not in mask('eq "PLACEHOLDER_aaaaaaaaaaaaaaaaaaaaaa"'))
    check("reports the masked length",
          mask('"' + "x" * 48 + '"') == '"<48-char value redacted>"')
    check("leaves an ordinary IP alone", mask("ip.src eq 203.0.113.9") == "ip.src eq 203.0.113.9")
    check("leaves a short user agent alone",
          mask('http.user_agent contains "ExampleBot"') == 'http.user_agent contains "ExampleBot"')

    print("role detection")
    check("a skip rule is rule 1", role_of("skip", "(cf.client.bot)") == "skip")
    check("a block rule is rule 5", role_of("block", '(ip.geoip.country in {"T1"})') == "block")
    check("many user agents means the crawler rule",
          role_of("managed_challenge",
                  " or ".join('(http.user_agent contains "x%d")' % i for i in range(5))) == "crawlers")
    check("ASNs plus countries means the providers rule",
          role_of("managed_challenge",
                  '(ip.geoip.asnum in {7224}) or (ip.geoip.country in {"CN"})') == "providers")

    print("diffing")
    base = '(a eq 1) or (b eq 2)'
    check("an identical rule reports no difference", diff_rule(base, base) == [])
    check("an added clause is reported",
          any("extra clause" in x for x in diff_rule(base + ' or (c eq 3)', base)))
    check("a removed clause is reported",
          any("clause removed" in x for x in diff_rule('(a eq 1)', base)))
    d = diff_rule('(ip.geoip.country in {"US" "CA"})', '(ip.geoip.country in {"US"})')
    check("a changed list reports the added value",
          len(d) == 1 and "list changed" in d[0] and "CA" in d[0])
    check("a credential inside a changed list is masked",
          "PLACEHOLDER" not in " ".join(
              diff_rule('(h eq "PLACEHOLDER_aaaaaaaaaaaaaaaaaaaaaa")', '(h eq "x")')))

    print("ordering is not drift")
    canon = {"providers": '(ip.geoip.asnum in {7224}) or (ip.geoip.country in {"CN"})',
             "crawlers": " or ".join('(http.user_agent contains "x%d")' % i for i in range(5)),
             "vpn": '(http.request.uri.path contains "wp-login")',
             "block": '(ip.geoip.country in {"T1"})'}
    def rule(desc, action, expr): return {"desc": desc, "action": action, "enabled": True,
                                          "expr": expr, "ap": {}, "id": desc}
    swapped = {"z": {"zone": "id", "status": "ok", "version": "1", "last_updated": "2026-01-01",
                     "ratelimit_rules": 0, "rules": [
        rule("Allow Good Bots", "skip", "(cf.client.bot)"),
        rule("Block", "block", canon["block"]),
        rule("Crawlers", "managed_challenge", canon["crawlers"]),
        rule("Providers", "managed_challenge", canon["providers"]),
        rule("VPN", "managed_challenge", canon["vpn"])]}}
    r = analyse(swapped, canon)["z"]
    check("rules 2 and 3 in the opposite order still read as the standard",
          r["klass"] == "standard-reordered" and r["findings"] == [])

    print("a block after a challenge is a defect, not a reorder (s1.4)")
    late = json.loads(json.dumps(swapped))
    late["z"]["rules"].append(late["z"]["rules"].pop(1))   # block moved to the end
    rl = analyse(late, canon)["z"]
    check("the old order (block last) is reported", rl["findings"] == [BLOCK_AFTER_CHALLENGE])
    check("  ...and the zone reads as a variant, not the standard", rl["klass"] == "variant")
    check("CONTROL - block second raises no such finding",
          BLOCK_AFTER_CHALLENGE not in r["findings"])
    off = json.loads(json.dumps(late))
    off["z"]["rules"][1]["enabled"] = False                # the only challenge before it, disabled
    off["z"]["rules"][2]["enabled"] = False
    off["z"]["rules"][3]["enabled"] = False
    check("a late block after only DISABLED challenges is not reported as late",
          BLOCK_AFTER_CHALLENGE not in analyse(off, canon)["z"]["findings"])

    print("negative control - the checks must be able to fail")
    broken = json.loads(json.dumps(swapped))
    broken["z"]["rules"][1]["expr"] = canon["block"] + ' or (ip.src eq 192.0.2.4)'
    rb = analyse(broken, canon)["z"]
    check("a planted extra clause is caught", rb["klass"] == "variant" and len(rb["findings"]) == 1)
    disabled = json.loads(json.dumps(swapped))
    disabled["z"]["rules"][3]["enabled"] = False
    rd = analyse(disabled, canon)["z"]
    check("a disabled rule is caught", any("DISABLED" in f for f in rd["findings"]))

    print("reachability - a proxied ruleset is not a protected site")
    def dnsr(name, typ, proxied, content="192.0.2.4"):
        return {"name": name, "type": typ, "proxied": proxied, "content": content}
    o = {}
    allp = dns_classify("example.com", [dnsr("example.com", "A", True),
                                   dnsr("www.example.com", "CNAME", True, "example.com"),
                                   dnsr("example.com", "MX", False, "mx.example.com"),
                                   dnsr("example.com", "TXT", False, "v=spf1")], o)
    check("every web record proxied reads as proxied",
          allp["reach"] == "proxied" and allp["grey"] == [])
    check("MX and TXT records are not counted as holes", allp["grey_other"] == 0)
    check("proxied hostnames are listed by name",
          allp["proxied_names"] == ["example.com", "www.example.com"])

    grey = dns_classify("example.com", [dnsr("example.com", "A", False),
                                   dnsr("www.example.com", "CNAME", True, "example.com")],
                        o, {"192.0.2.4"}, {"www.example.com"})
    check("a grey-cloud apex on one of your own origins is caught",
          grey["reach"] == "bypass" and grey["grey_front"] == 1
          and grey["grey"][0]["cls"] == "ours")
    greyw = dns_classify("example.com", [dnsr("example.com", "A", True),
                                    dnsr("www.example.com", "CNAME", False, "example.com")],
                         o, {"192.0.2.4"}, {"example.com"})
    check("a grey-cloud www pointing at your proxied apex is caught too",
          greyw["reach"] == "bypass" and greyw["grey"][0]["cls"] == "inzone")

    sub = dns_classify("example.com", [dnsr("example.com", "A", True),
                                  dnsr("staging.example.com", "A", False, "192.0.2.99")], o)
    check("a grey-cloud subdomain is noted without being a front-door bypass",
          sub["reach"] == "proxied" and sub["grey_other"] == 1 and sub["grey_front"] == 0)

    deleg = dns_classify("example.com", [
        dnsr("example.com", "A", True),
        dnsr("pm-bounces.example.com", "CNAME", False, "bounces.example.net"),
        dnsr("autodiscover.example.com", "CNAME", False, "autodiscover.example.net"),
        dnsr("cdn.example.com", "CNAME", False, "cdn.example.net")], o)
    check("a CNAME pointing outside the zone is delegation, not an exposed origin",
          deleg["reach"] == "proxied" and deleg["grey_other"] == 0 and deleg["delegated"] == 3)
    staging = dns_classify("example.com", [dnsr("example.com", "A", True),
                                      dnsr("staging.example.com", "A", False, "192.0.2.99")], o)
    check("a grey staging A record IS an exposed origin", staging["grey_other"] == 1)
    inzone = dns_classify("example.com", [dnsr("example.com", "A", True),
                                     dnsr("old.example.com", "CNAME", False, "example.com")], o)
    check("a CNAME pointing back inside the zone is an exposed origin",
          inzone["grey_other"] == 1 and inzone["delegated"] == 0)
    frontout = dns_classify("example.com", [dnsr("example.com", "A", True),
                                       dnsr("www.example.com", "CNAME", False, "sites.example.net")], o)
    check("a grey www pointing at an unrecognized host is flagged for review, "
          "not silently dropped",
          frontout["reach"] == "review" and frontout["delegated"] == 0
          and frontout["grey"][0]["cls"] == "unidentified")

    parked = dns_classify("example.com", [dnsr("example.com", "MX", False, "mx.example.com")], o)
    check("a zone with no web record is not reported as a bypass",
          parked["reach"] == "no-site")

    check("no origin address reaches the report", not any(
        re.search(r"\d+\.\d+\.\d+\.\d+", json.dumps(x))
        for x in (allp, grey, greyw, sub, parked, deleg, staging, inzone, frontout)))
    check("the same origin gets the same label across zones",
          sub["grey"][0]["origin"] == dns_classify(
              "example.org", [dnsr("example.org", "A", False, "192.0.2.99")], o)["grey"][0]["origin"])

    print("whose server is behind a grey front door")
    sq = dns_classify("example.net", [
        dnsr("example.net", "A", False, "198.185.159.144"),
        dnsr("example.net", "A", False, "198.49.23.145"),
        dnsr("www.example.net", "CNAME", False, "ext-sq.squarespace.com"),
        dnsr("training.example.net", "A", True, "203.0.113.50")], o,
        {"203.0.113.50"}, {"training.example.net"})
    check("a Squarespace front door is not reported as a bypass",
          sq["reach"] == "platform-front")
    check("  ...by its documented apex addresses AND its www CNAME",
          sq["front_classes"] == {"platform": 3})
    check("a platform suffix matches on a dot boundary only",
          not is_platform("notsquarespace.com") and is_platform("x.squarespace.com"))

    park = dns_classify("parked.example", [dnsr("parked.example", "A", True, "198.51.100.5"),
                                   dnsr("www.parked.example", "CNAME", False,
                                        "parkingpage.namecheap.com")],
                        o, {"198.51.100.5", "parkingpage.namecheap.com"}, {"parked.example"})
    check("a www on a parking page is a platform, not one of your origins",
          park["reach"] == "platform-front" and park["grey"][0]["cls"] == "platform")

    ours = dns_classify("dev.example", [dnsr("dev.example", "A", False, "198.51.100.77")],
                        o, {"198.51.100.77"}, set())
    check("an apex on an address you proxy in another zone is a real bypass",
          ours["reach"] == "bypass" and ours["grey"][0]["cls"] == "ours")
    unid = dns_classify("dev.example", [dnsr("dev.example", "A", False, "198.51.100.78")],
                        o, {"198.51.100.77"}, set())
    check("an address you proxy nowhere is unidentified, not assumed either way",
          unid["reach"] == "review" and unid["grey"][0]["cls"] == "unidentified")

    cn = {"a.example": {"zone": "i", "status": "ok", "ratelimit_rules": 0, "rules": [],
                    "dns": [dnsr("a.example", "CNAME", True, "parkingpage.namecheap.com")]},
          "b.example": {"zone": "i", "status": "ok", "ratelimit_rules": 0, "rules": [],
                    "dns": [dnsr("b.example", "CNAME", False, "host.example.net")]}}
    rcn = analyse(cn, canon)
    check("a PROXIED CNAME's target never joins the set of your origins",
          rcn["b.example"]["reach"]["grey"][0]["cls"] == "unidentified")
    # The parking-page bug is held off by two independent guards: the prepass
    # adds only A/AAAA content to the origin set, AND the "ours" branch accepts
    # only A/AAAA records. Planting a defect in the prepass alone changed no
    # result, so that first check proved nothing by itself. This one pins the
    # second guard directly.
    check("a grey CNAME is never one of your origins, even when its own target "
          "is in the proxied set",
          dns_classify("example.com", [dnsr("example.com", "CNAME", False,
                                       "shared.example.net")],
                       o, {"shared.example.net"}, set())
          ["grey"][0]["cls"] == "unidentified")
    check("the set of your origins is built across zones, not per zone", analyse(
        {"x.example": {"zone": "i", "status": "ok", "ratelimit_rules": 0, "rules": [],
                   "dns": [dnsr("x.example", "A", False, "198.51.100.90")]},
         "y.example": {"zone": "i", "status": "ok", "ratelimit_rules": 0, "rules": [],
                   "dns": [dnsr("y.example", "A", True, "198.51.100.90")]}},
        canon)["x.example"]["reach"]["reach"] == "bypass")

    print("negative controls for the class split")
    check("CONTROL - without the platform table the Squarespace zone WOULD read as review",
          dns_classify("example.net", [dnsr("example.net", "A", False, "192.0.2.9"),
                                   dnsr("www.example.net", "CNAME", False, "ext-sq.example")],
                       o)["reach"] == "review")
    check("CONTROL - the in-zone rule needs the target to be PROXIED",
          dns_classify("example.com", [dnsr("example.com", "A", False),
                                  dnsr("www.example.com", "CNAME", False, "example.com")],
                       o, set(), set())["reach"] == "review")
    check("no origin address reaches the report from the new classes", not any(
        re.search(r"\d+\.\d+\.\d+\.\d+", json.dumps(x))
        for x in (sq, park, ours, unid, frontout)))

    print("the false clean this check exists to catch")
    bypass = json.loads(json.dumps(swapped))
    bypass["z"]["dns"] = [dnsr("z", "A", False, "203.0.113.9"),
                          dnsr("app.z", "A", True, "203.0.113.9")]
    rbp = analyse(bypass, canon)["z"]
    check("a zone with the full standard and a grey apex still classes as standard",
          rbp["klass"] == "standard-reordered" and rbp["findings"] == [])
    check("  ...and its reach is nonetheless reported as a bypass",
          rbp["reach"]["reach"] == "bypass")
    nonez = {"z2": {"zone": "id", "status": "no-entrypoint", "ratelimit_rules": 0,
                    "rules": [], "dns": [dnsr("z2", "A", False, "203.0.113.9"),
                                         dnsr("app.z2", "A", True, "203.0.113.9")]}}
    check("a zone with no rules at all is still classified for reach",
          analyse(nonez, canon)["z2"]["reach"]["reach"] == "bypass")
    check("a zone whose DNS could not be read reads as unknown, not as clean",
          analyse({"z3": {"zone": "id", "status": "no-entrypoint", "ratelimit_rules": 0,
                          "rules": [], "dns": None}}, canon)["z3"]["reach"]["reach"] == "unknown")

    print("two profiles, compared against the right canon")
    # A four-rule static-profile zone: skip / other(no country) / crawlers / block.
    # role_of falls back to "vpn" for any expression under 300 chars, so the
    # providers-without-country rule is taken from the sample standard rather
    # than hand-written short: a toy clause here classifies as "vpn" and the
    # zone then matches no profile.
    sc = {"other": load_canon(SAMPLE, "static")["other"],
          "crawlers": " or ".join('(http.user_agent contains "x%d")' % i for i in range(5)),
          "block": '(http.request.uri.path contains ".php") or (ip.geoip.country in {"T1"})'}
    both = {"wordpress": canon, "static": sc}
    def statz(block=None):
        return {"z": {"zone": "id", "status": "ok", "version": "1",
                      "last_updated": "2026-01-01", "ratelimit_rules": 0, "rules": [
            rule("Good Bots Allow", "skip", "(cf.client.bot)"),
            rule("Block Hosting Networks", "block", block or sc["block"]),
            rule("MC Providers", "managed_challenge", sc["other"]),
            rule("MC Aggressive Crawlers", "managed_challenge", sc["crawlers"])]}}
    rs = analyse(statz(), both)["z"]
    check("a static-profile zone is compared against the static canon, not the five-rule one",
          rs["profile"] == "static" and rs["klass"] == "standard" and rs["findings"] == [])
    # THE control: drift inside the static profile must be reported as a
    # variant, never fall through to the unchecked "custom" bucket.
    rd2 = analyse(statz(sc["block"] + ' or (http.request.uri.path contains "/.ssh")'), both)["z"]
    check("a planted extra clause in a STATIC zone is a variant, not 'custom'",
          rd2["profile"] == "static" and rd2["klass"] == "variant"
          and len(rd2["findings"]) == 1)
    # and a five-rule zone must still go to the wordpress canon
    rw = analyse(swapped, both)["z"]
    check("a five-rule zone still goes to the wordpress canon",
          rw["profile"] == "wordpress" and rw["klass"] == "standard-reordered")
    # a shape matching neither profile stays unchecked, and says so
    rn = analyse({"z": {"zone": "id", "status": "ok", "version": "1",
                        "last_updated": "2026-01-01", "ratelimit_rules": 0, "rules": [
        rule("Block old HTTP", "block", '(http.request.version in {"HTTP/1.0"})')]}}, both)["z"]
    check("a shape matching no profile is 'custom' with profile None",
          rn["klass"] == "custom" and rn["profile"] is None)
    check("the static canon's rule 3 is byte-identical to the wordpress one",
          load_canon(SAMPLE, "static")["crawlers"] == load_canon(SAMPLE)["crawlers"])

    print("a per-rule guard is read as a guard, not as dozens of lines of drift")
    G = '(not http.host eq "x.example.com")'
    real = load_canon(SAMPLE)
    gf = diff_rule(G + " and (" + real["crawlers"] + ")", real["crawlers"])
    check("a guarded rule reports the guard once and nothing else",
          gf == ['guarded by: (not http.host eq "x.example.com")'])
    check("an unguarded rule identical to the canon still reports nothing",
          diff_rule(real["crawlers"], real["crawlers"]) == [])
    # THE control: stripping the guard must not swallow drift inside the body.
    df = diff_rule(G + " and (" + real["crawlers"] + ' or (http.user_agent contains "zzz"))',
                   real["crawlers"])
    check("CONTROL - drift INSIDE a guarded rule is still reported",
          len(df) == 2 and any("zzz" in x for x in df))
    # The sample's rule 2 begins with a clause that starts with "not", which
    # must not be mistaken for a guard wrapper: unguard only strips a balanced
    # leading group that is followed by "and (".
    check("a rule whose own clause starts with 'not' is not mis-stripped",
          unguard(real["providers"])[0] is None)
    check("an unbalanced body is left alone rather than half-stripped",
          unguard('(not a) and (b) or (c)')[0] is None)

    print("the dev profile: rule 1 inverted, rules 2-5 inherited")
    dc = load_canon(SAMPLE, "dev")
    def devz(rule1=None, host_guard=False):
        g = '(not http.host eq "x.example.com") and ' if host_guard else ""
        return {"z": {"zone": "id", "status": "ok", "version": "1",
                      "last_updated": "2026-01-01", "ratelimit_rules": 0, "rules": [
            rule("Block Indexing Bots (dev)", "block", g + (rule1 or dc["noindex"])),
            rule("Block Web Hosts",         "block",             g + dc["block"]),
            rule("MC Providers",            "managed_challenge", g + dc["providers"]),
            rule("MC Aggressive Crawlers",  "managed_challenge", g + dc["crawlers"]),
            rule("MC VPNs and WP Login",    "managed_challenge", g + dc["vpn"])]}}
    allc = load_canons(SAMPLE)
    rd = analyse(devz(), allc)["z"]
    check("a dev-shaped zone is compared against the dev canon",
          rd["profile"] == "dev" and rd["klass"] == "standard" and rd["findings"] == [])
    # role_of must tell the dev rule 1 from the standard rule 5: BOTH are block
    # actions, and judging by position would break on a reordered zone.
    check("rule 1 reads as 'noindex' and rule 5 as 'block', though both block",
          [x["role"] for x in rd["rules"]] ==
          ["noindex", "block", "providers", "crawlers", "vpn"])
    check("the dev canon inherits rules 2-5 from the wordpress canon byte for byte",
          all(dc[k] == load_canon(SAMPLE)[k] for k in ("providers", "crawlers", "vpn", "block")))
    # THE control: drift inside the dev profile must be a variant, never fall
    # through to the unchecked "custom" bucket.
    rdd = analyse(devz(dc["noindex"] + ' or (cf.verified_bot_category in {"Other"})'),
                  allc)["z"]
    check("a planted extra clause in a DEV zone is a variant, not 'custom'",
          rdd["profile"] == "dev" and rdd["klass"] == "variant"
          and len(rdd["findings"]) == 1)
    # A per-zone guard is a documented variant (s1.3): still compared, still
    # reported, never silently "standard".
    rdg = analyse(devz(host_guard=True), allc)["z"]
    check("a per-host guard keeps the zone comparable and marks it a variant",
          rdg["profile"] == "dev" and rdg["klass"] == "variant" and rdg["findings"])
    # A dev zone must never be measured against the static rule 5, which blocks
    # .php and /wp- and would take a WordPress site down.
    check("the dev and static canons do NOT share a rule 5",
          dc["block"] != load_canon(SAMPLE, "static")["block"])

    print("the standard document: read whole, or not at all")
    try:
        c = load_canon(SAMPLE)
        check("all four standard rules found in the sample",
              set(c) == {"providers", "crawlers", "vpn", "block"}
              and all(len(v) > 100 for v in c.values()))
        allp = load_canons(SAMPLE)
        check("all three profiles parse from the sample",
              sorted(allp) == ["dev", "static", "wordpress"]
              and len(allp["static"]) == 3 and len(allp["dev"]) == 5
              and all(len(v) > 100 for v in allp["static"].values()))
    except SystemExit as e:
        check("the sample's rule blocks all parse (%s)" % e, False)
    def doc(name, text):
        path = os.path.join(TMP, name)
        with open(path, "w") as f:
            f.write(text)
        return path
    def cut(text, heading):
        """The sample without the one rule block under that heading."""
        return re.sub(r"\*\*%s[^\n]*\n+```\n.*?```\n" % re.escape(heading), "", text, flags=re.S)
    def stops(fn):
        try:
            fn(); return ""
        except SystemExit as e:
            return str(e)
    static_cut = SAMPLE_STANDARD
    for h in ("Static rule 2", "Static rule 3", "Static rule 5"):
        static_cut = cut(static_cut, h)
    five_only = doc("five.md", cut(static_cut, "Dev rule 1"))
    only = load_canons(five_only)
    check("a document with only the five rules describes one profile", sorted(only) == ["wordpress"])
    def fivez(c):
        return {"z": {"zone": "id", "status": "ok", "version": "1",
                      "last_updated": "2026-01-01", "ratelimit_rules": 0, "rules": [
            rule("Good Bots Allow",        "skip",              "(cf.client.bot)"),
            rule("Block Web Hosts",        "block",             c["block"]),
            rule("MC Providers",           "managed_challenge", c["providers"]),
            rule("MC Aggressive Crawlers", "managed_challenge", c["crawlers"]),
            rule("MC VPNs and WP Login",   "managed_challenge", c["vpn"])]}}
    r5 = analyse(fivez(only["wordpress"]), only)["z"]
    check("  ...and a five-rule zone is still compared against it",
          r5["profile"] == "wordpress" and r5["klass"] == "standard" and r5["findings"] == [])
    rsu = analyse(statz(), only)["z"]
    check("CONTROL a static-shaped zone with no static profile written down is NOT standard",
          rsu["klass"] == "custom" and rsu["profile"] is None and rsu["nearest"] == "static"
          and rsu["comparable"] is False)
    check("no document at all means no profile", load_canons(None) == {})
    rnone = analyse(fivez(only["wordpress"]), load_canons(None))["z"]
    check("CONTROL with no document, a zone carrying all five rules is NOT standard",
          rnone["klass"] == "custom" and rnone["profile"] is None
          and rnone["nearest"] == "wordpress" and rnone["comparable"] is False)
    check("  ...and what does not need a standard is still reported (a late block)",
          BLOCK_AFTER_CHALLENGE in analyse(late, load_canons(None))["z"]["findings"])
    half = doc("half.md", cut(SAMPLE_STANDARD, "Rule 3"))
    check("half a profile stops the run and names the missing rule",
          "could not find Rule 3" in stops(lambda: load_canons(half)))
    orphan = doc("orphan.md", cut(cut(cut(cut(static_cut, "Rule 2"), "Rule 3"), "Rule 4"), "Rule 5"))
    check("a dev profile with no five rules to inherit stops the run",
          "takes its other rules from" in stops(lambda: load_canons(orphan)))
    keep = {k: os.environ.get(k) for k in ("WAF_STANDARD", "XDG_CONFIG_HOME")}
    try:
        os.environ["XDG_CONFIG_HOME"] = os.path.join(TMP, "no-settings")
        os.environ.pop("WAF_STANDARD", None)
        check("no setting means no document, not a guess", standard_path() is None)
        os.environ["WAF_STANDARD"] = os.path.join(TMP, "missing.md")
        check("a document that is named but missing stops the run",
              "is not there" in stops(standard_path))
        os.makedirs(os.path.join(TMP, "settings", "fleet"))
        doc(os.path.join("settings", "fleet", "waf-standard"), "# my standard\n" + five_only + "\n")
        os.environ["XDG_CONFIG_HOME"] = os.path.join(TMP, "settings")
        check("the environment wins over the settings file", "missing.md" in stops(standard_path))
        os.environ.pop("WAF_STANDARD")
        check("the settings file names the document", standard_path() == five_only)
        check("--standard wins over both", standard_path(SAMPLE) == SAMPLE)
    finally:
        for k, v in keep.items():
            if v is None: os.environ.pop(k, None)
            else: os.environ[k] = v

    print("the token never rides on a command line, and never leaves this machine")
    real_run, seen = subprocess.run, {}
    def fake_run(argv, **kw):
        seen.update(argv=argv, input=kw.get("input"))
        return collections.namedtuple("R", "stdout")('{"success": true}\n200')
    keep = os.environ.get("WAF_API_BASE")
    try:
        subprocess.run = fake_run
        os.environ.pop("WAF_API_BASE", None)
        code, body = _curl("tok-for-the-selftest", "/zones")
        check("the token reaches curl on standard input",
              seen["input"] == "Authorization: Bearer tok-for-the-selftest\n" and code == "200")
        check("CONTROL the token is in no argument curl is started with",
              not any("tok-for-the-selftest" in a for a in seen["argv"]) and "@-" in seen["argv"])
        check("with nothing set, requests go to Cloudflare's API",
              seen["argv"][-1] == CLOUDFLARE_API + "/zones")
        os.environ["WAF_API_BASE"] = "http://127.0.0.1:8123/"
        check("a stand-in on this machine is accepted", api_base() == "http://127.0.0.1:8123")
        for bad in ("https://api.example.com/client/v4", "http://127.0.0.1.example.com:80",
                    "http://192.0.2.10:8123", "http://localhost.example.com:8123"):
            os.environ["WAF_API_BASE"] = bad
            check("CONTROL any other address is refused: %s" % bad,
                  "Refusing to send a token anywhere else" in stops(api_base))
    finally:
        subprocess.run = real_run
        if keep is None: os.environ.pop("WAF_API_BASE", None)
        else: os.environ["WAF_API_BASE"] = keep

    print()
    if fails:
        print("%d CHECK(S) FAILED" % len(fails)); return 1
    print("all checks passed"); return 0

# ---------------------------------------------------------------- output

def write_html(report, out):
    """Optional: a page of your own, built from the same report. The template is
    any HTML file that carries the text __DATA__ where the data goes."""
    tpl = setting("WAF_PAGE_TEMPLATE", "waf-page-template")
    if not tpl:
        return None
    tpl = os.path.expanduser(tpl)
    if not os.path.isfile(tpl):
        print("  the page template is set to %s, and that file is not there; wrote report.json only" % tpl)
        return None
    html = open(tpl).read().replace("__DATA__", json.dumps(
        {"generated": time.strftime("%Y-%m-%d"), "zones": report,
         "groups": {fp: sorted(z) for fp, z in _groups(report).items() if len(z) > 1},
         "counts": dict(collections.Counter(v["klass"] for v in report.values()))},
        separators=(",", ":")))
    p = os.path.join(out, "index.html")
    open(p, "w").write(html)
    return p

def _groups(report):
    g = collections.defaultdict(list)
    for n, v in report.items():
        if v["klass"] != "none": g[v["core_fp"]].append(n)
    return g

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="waf-inventory",
                    help="the folder to write report.json into (default: ./waf-inventory)")
    ap.add_argument("--standard", metavar="FILE",
                    help="your standard document (default: WAF_STANDARD, else the path in "
                         "~/.config/fleet/waf-standard, else none: nothing is compared)")
    ap.add_argument("--selftest", action="store_true", help="offline checks, no API calls")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    std = standard_path(a.standard)
    canon = load_canons(std)
    if canon:
        print("standard loaded from %s: %s" % (std, ", ".join(
            "%s %dc" % (k, len(v)) for k, v in sorted(canon.items()))))
    elif std:
        raise SystemExit("%s has no rule block this script can read (a heading such as "
                         "**Rule 2** followed by a code block). See docs/cloudflare-waf-standard.md." % std)
    else:
        print("no standard document is set, so NO ZONE IS COMPARED: every zone with rules reads "
              "as \"custom\".\n  Write one (docs/cloudflare-waf-standard.md) and name it with "
              "--standard, WAF_STANDARD or %s." % os.path.join(config_dir(), "waf-standard"))
    api_base()   # a bad WAF_API_BASE stops here, before the token is read
    report = analyse(sweep(cf_token()), canon)
    os.makedirs(a.out, exist_ok=True)
    json.dump(report, open(os.path.join(a.out, "report.json"), "w"), indent=1)
    counts = collections.Counter(v["klass"] for v in report.values())
    print()
    for k in ("standard", "standard-reordered", "variant", "custom", "none"):
        if counts.get(k): print("  %-20s %d" % (k, counts[k]))
    def by_reach(k):
        return sorted(n for n, v in report.items() if v["reach"]["reach"] == k)
    byp, rev, plat, unk = (by_reach("bypass"), by_reach("review"),
                           by_reach("platform-front"), by_reach("unknown"))
    oth = sorted(n for n, v in report.items()
                 if v["reach"]["reach"] != "bypass" and v["reach"]["grey_other"])
    print()
    if byp:
        print("  BYPASS - one of your own origins is in front of the rules "
              "on %d zone(s):" % len(byp))
        for n in byp:
            r = report[n]["reach"]
            fc = ", ".join("%d %s" % (c, k) for k, c in sorted(r["front_classes"].items()))
            print("    %-34s %-20s %s" % (n, report[n]["klass"], fc))
    else:
        print("  no zone has one of your origins at a grey front door")
    if rev:
        print("  REVIEW - %d zone(s) have an unidentified front door; "
              "probe each by hand:" % len(rev))
        for n in rev:
            print("    %-34s %-20s %d unidentified" % (
                n, report[n]["klass"], report[n]["reach"]["front_classes"].get("unidentified", 0)))
    if plat:
        print("  %d zone(s) front on a third-party platform, grey by design: %s"
              % (len(plat), ", ".join(plat)))
    if oth:
        print("  %d zone(s) expose an origin on a subdomain only: %s" % (len(oth), ", ".join(oth)))
    dl = sum(v["reach"].get("delegated", 0) for v in report.values())
    print("  %d delegated CNAME(s) excluded by design (mail, DKIM, Microsoft, CDN)" % dl)
    if unk:
        print("  DNS unreadable on %d zone(s): %s" % (len(unk), ", ".join(unk)))

    big = sorted(_groups(report).items(), key=lambda t: -len(t[1]))
    if big and len(big[0][1]) > 1:
        print("\n  largest identical group: %d zones (rules 2-5 fingerprint %s)"
              % (len(big[0][1]), big[0][0]))
    print("\n  wrote %s" % os.path.join(a.out, "report.json"))
    p = write_html(report, a.out)
    if p: print("  wrote %s" % p)

if __name__ == "__main__":
    main()
