#!/usr/bin/env python3
"""The WAF inventory and the settings around it, proved without Cloudflare.

    python3 scripts/test-waf-inventory.py              the whole proof   (npm run wafinv:test)
    python3 scripts/test-waf-inventory.py --controls   break a copy of the scripts on purpose, one
                                                       way at a time, and check this test notices
    python3 scripts/test-waf-inventory.py --parts A,B  only those parts
    python3 scripts/test-waf-inventory.py --quiet      print failures and the last line only

NOTHING HERE REACHES CLOUDFLARE, A SERVER OR A DATABASE. The scripts under test
are copied to a temporary folder and run there with a made-up HOME. Cloudflare
is a stand-in web server this test starts on 127.0.0.1 and stops again. `curl`
is a stand-in that passes requests for 127.0.0.1 to the real curl and refuses
every other address, and `ssh` is a stand-in that writes down what it was given.
Every token is a made-up string. The ingest is only ever run with --dry-run,
which stops before it opens a database.

A. The inventory against a fake Cloudflare API: nine made-up zones over three
   pages. The report's shape is held to the types the app declares
   (lib/cloudflare-waf.ts) and to the ingest's own validation; each zone's class,
   profile, findings and DNS reach are checked by value; a value that looks like
   a key is masked; a read that fails stops the run with no report; with no
   standard document no zone reads as standard. Then four more zones, three of
   them with more DNS records than one request returns: every page is read, and
   a page that cannot be read makes that zone unknown, never a shorter list.
B. Where a token is looked for: the environment, then your command, then your
   file, in the shell (lib-fleet-token.sh) and in the inventory, side by side on
   the same made-up settings. Each refusal is provoked on purpose.
C. The output folder: one setting, read by one shell function
   (lib-fleet-output.sh) that the five shell scripts all call, and by the ingest
   in TypeScript; the two are asked side by side on the same made-up settings.
   A lookup that finds nothing says which folder it searched and how to point
   at another one.
D. scripts/waf-refresh.sh from end to end, with --dry-run: a failed inventory
   and a refused ingest are each tried once more after the wait, and only the
   second failure stops the job. The wait itself is a stand-in `sleep` that
   writes down how long it was asked for and returns at once.
E. The token on its way to a server: inside the text sent down ssh's standard
   input, never among ssh's arguments, never printed.

The last line is `<n> checks, 0 failed`, or the number that failed.
"""
import hashlib, http.server, importlib.util, json, os, re, shutil, stat, subprocess, sys, tempfile, threading, time
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
TREE = os.environ.get("WAFINV_TREE") or REPO          # the scripts under test (a broken copy, in --controls)

ARGS = sys.argv[1:]
QUIET = "--quiet" in ARGS
CONTROLS = "--controls" in ARGS
PARTS = "ABCDE"
if "--parts" in ARGS:
    PARTS = ARGS[ARGS.index("--parts") + 1].replace(",", "").upper()
for a in ARGS:
    if a in ("-h", "--help"):
        print(__doc__); sys.exit(0)
    if a.startswith("--") and a not in ("--quiet", "--controls", "--parts"):
        print("Unknown option: %s (only --controls, --parts, --quiet)" % a); sys.exit(2)

# The line every script that keeps something on this machine reads its folder with:
# the one function in lib-fleet-output.sh, and nothing of its own.
FOLDER_LINE = '. "$(dirname "$0")/lib-fleet-output.sh" || exit 1; FLEET_OUT="$(fleet_output_dir)"'
FOLDER_LIB = "lib-fleet-output.sh"
# What only that library may hold, outside comments: the two names the setting goes by.
FOLDER_PIECES = r"FLEET_OUTPUT_DIR|fleet/output-dir"
FOLDER_SCRIPTS = ["waf-refresh.sh", "fleet-fail2ban.sh", "fleet-fail2ban-apply.sh",
                  "fleet-server-snapshot.sh", "fleet-server-restore.sh"]

ran = failed = 0
PART = ""
def check(label, cond, detail=""):
    global ran, failed
    ran += 1
    if cond:
        if not QUIET: print("  ok   %s  %s" % (PART, label))
    else:
        failed += 1
        print("  FAIL %s  %s%s" % (PART, label, ("  (%s)" % detail) if detail else ""))
def say(text):
    if not QUIET: print(text)

REAL = {t: shutil.which(t) for t in ("curl", "python3", "node", "bash")}
for t, p in REAL.items():
    if not p:
        print("ABORT: %s is needed and is not on the PATH" % t); sys.exit(1)


# ------------------------------------------------------------------------------
# A copy of the scripts, so nothing they write lands in the repository
# ------------------------------------------------------------------------------
def copy_tree(src, dst):
    if not os.path.isfile(os.path.join(src, "fleet.config.ts")):
        print("ABORT: %s/fleet.config.ts is not there. Copy fleet.config.example.ts to it first." % src); sys.exit(1)
    os.makedirs(dst)
    shutil.copytree(os.path.join(src, "scripts"), os.path.join(dst, "scripts"),
                    ignore=shutil.ignore_patterns("servers.local", "__pycache__"))
    shutil.copytree(os.path.join(src, "lib"), os.path.join(dst, "lib"))
    for f in ("fleet.config.ts", "package.json", "tsconfig.json"):
        if os.path.isfile(os.path.join(src, f)):
            shutil.copy(os.path.join(src, f), os.path.join(dst, f))
    # The ingest needs the installed packages; they are looked for in the tree
    # under test first, then in this checkout.
    for base in (src, REPO):
        nm = os.path.join(base, "node_modules")
        if os.path.isdir(nm):
            os.symlink(os.path.realpath(nm), os.path.join(dst, "node_modules")); break
    return dst


# ==============================================================================
# --controls: break a copy one way at a time; each must be noticed
# ==============================================================================
def controls():
    tries = [
        # (what is broken, the part that must fail, the file, what to find, what to put)
        ("the inventory stops masking long values", "A", "waf-inventory.py",
         r'lambda m: "<%d-char value redacted>" % len\(m\.group\(0\)\), s\)', 'lambda m: m.group(0), s)'),
        ("the inventory puts the token on curl's command line", "A", "waf-inventory.py",
         r'"-H", "@-", api_base\(\) \+ path\],\n\s+input="Authorization: Bearer " \+ tok \+ "\\n",',
         '"-H", "Authorization: Bearer " + tok, api_base() + path],'),
        ("a read that fails is recorded as a zone with no rules", "A", "waf-inventory.py",
         r'elif not d\.get\("success"\):\n\s+unread\("the custom rules", name, d\)',
         'elif not d.get("success"):\n            rec.update(status="no-entrypoint", rules=[])'),
        ("a zone reads as standard with no document to compare it against", "A", "waf-inventory.py",
         r'prof = shape if canons\.get\(shape\) else None', 'prof = shape'),
        ("only the first page of zones is read", "A", "waf-inventory.py",
         r'        zones \+= got\n', '        zones += got\n        return zones\n'),
        ("a zone page that cannot be read ends the list instead of stopping the run", "A", "waf-inventory.py",
         r'if not d\.get\("success"\) or not isinstance\(got, list\):\n\s+raise SystemExit\("zone list failed: %s" % d\.get\("errors"\)\)',
         'if not d.get("success") or not isinstance(got, list):\n            if page > 1: return zones\n            raise SystemExit("zone list failed: %s" % d.get("errors"))'),
        ("a full page of zones with no count is taken for the whole list", "A", "waf-inventory.py",
         r'if len\(got\) < ZONE_PAGE and total == len\(zones\):', 'if total is None or total == len(zones):'),
        ("fewer zones than Cloudflare counted is handed on as the whole list", "A", "waf-inventory.py",
         r'if total is not None and total > len\(zones\):', 'if False:'),
        ("only the first page of a zone's DNS records is read", "A", "waf-inventory.py",
         r'        out \+= got\n', '        out += got\n        return out\n'),
        ("a DNS page that cannot be read ends the list instead of failing the zone", "A", "waf-inventory.py",
         r'if not d\.get\("success"\) or not isinstance\(got, list\):\n\s+return None',
         'if not d.get("success") or not isinstance(got, list):\n            return out if page > 1 else None'),
        ("a full page of DNS records with no count is taken for the whole list", "A", "waf-inventory.py",
         r'if len\(got\) < DNS_PAGE and total == len\(out\):', 'if total is None or total == len(out):'),
        ("the inventory would send its token to any address", "A", "waf-inventory.py",
         r'if not re\.match\(r"\^http://127[^\n]*, v\):', 'if False:'),
        ("the shell takes a token file before the environment", "B", "lib-fleet-token.sh",
         r'if \[ -n "\$\{!__env:-\}" \]; then', 'if [ -n "${!__env:-}" ] && [ ! -e "$__file" ]; then'),
        ("the shell accepts a token file other people can read", "B", "lib-fleet-token.sh",
         r'\[ "\$\(printf \'%s\' "\$__mode" \| cut -c5-10\)" != "------" \]', 'false'),
        ("the shell runs a command file anyone can change", "B", "lib-fleet-token.sh",
         r'if \[ ! -O "\$__cmdfile" \] \|\| [^\n]*; then', 'if false; then'),
        ("the shell hands back a value with a quote in it", "B", "lib-fleet-token.sh",
         r"__token_re='[^']*'", "__token_re='.'"),
        ("the shell prints the token", "B", "lib-fleet-token.sh",
         r'printf -v "\$__var" \'%s\' "\$__val"\n', 'printf -v "$__var" \'%s\' "$__val"; echo "$__val"\n'),
        ("the inventory looks for its token in another order than the shell", "B", "waf-inventory.py",
         r'if os\.environ\.get\(env\):', 'if os.environ.get(env) and not line:'),
        ("the inventory accepts a token file other people can read", "B", "waf-inventory.py",
         r'not st\.st_mode & \(stat\.S_IRWXG \| stat\.S_IRWXO\)', 'True'),
        ("the inventory tries the file after its command failed", "B", "waf-inventory.py",
         r'if r\.returncode != 0:\n', 'if r.returncode != 0 and not os.path.exists(tokfile):\n'),
        ("one script keeps what it writes in a folder of its own again", "C", "fleet-server-snapshot.sh",
         r'\$FLEET_OUT/\$\(date \+%F\)-server-snapshots', '$HOME/Projects/backups/$(date +%F)-server-snapshots'),
        ("the shell reads the folder setting from another file", "C", "lib-fleet-output.sh",
         r'/fleet/output-dir"; \}', '/fleet/out-dir"; }'),
        ("the shell takes the settings file before the environment", "C", "lib-fleet-output.sh",
         r'local dir="\$\{FLEET_OUTPUT_DIR:-\}"\n(\s+)\[ -n "\$dir" \] \|\| dir="\$\(cat "\$\(fleet_output_dir_file\)" 2>/dev/null\)"',
         'local dir="$(cat "$(fleet_output_dir_file)" 2>/dev/null)"\n    [ -n "$dir" ] || dir="${FLEET_OUTPUT_DIR:-}"'),
        ("one script works the folder out for itself again", "C", "fleet-server-restore.sh",
         r'FLEET_OUT="\$\(fleet_output_dir\)"', 'FLEET_OUT="${FLEET_OUTPUT_DIR:-$HOME/.local/state/fleet}"'),
        ("one script reads the settings file for itself, beside the function", "C", "waf-refresh.sh",
         r'\nBACKUPS="\$FLEET_OUT"\n', '\nBACKUPS="$(cat "$HOME/.config/fleet/output-dir" 2>/dev/null || echo "$FLEET_OUT")"\n'),
        ("the ingest takes the settings file before the environment", "C", "ingest-waf-report.ts",
         r'process\.env\.FLEET_OUTPUT_DIR \|\|\n(\s+)outputDirFromFile\(\) \|\|', 'outputDirFromFile() ||\n    process.env.FLEET_OUTPUT_DIR ||'),
        ("the ingest ignores XDG_STATE_HOME", "C", "ingest-waf-report.ts",
         r'join\(process\.env\.XDG_STATE_HOME \|\| join\(homedir\(\), "\.local", "state"\), "fleet"\)', 'join(homedir(), ".local", "state", "fleet")'),
        ("a restore that finds no snapshot no longer says where it looked", "C", "fleet-server-restore.sh",
         r'        fleet_output_dir_hint\n', ''),
        ("a restore that finds no snapshot no longer says --snapshot can name one", "C", "fleet-server-restore.sh",
         r"        echo \"       Or name one snapshot's folder for this run: --snapshot <path>\"\n", ''),
        ("the apply script that finds no audit no longer says where it looked", "C", "fleet-fail2ban-apply.sh",
         r'(no Fail2Ban audit found\."\n)    fleet_output_dir_hint\n', r'\1'),
        ("the apply script that finds no inventory no longer says where it looked", "C", "fleet-fail2ban-apply.sh",
         r'(report\.json\) found\."\n)    fleet_output_dir_hint\n', r'\1'),
        ("the hint no longer says how to point at another folder", "C", "lib-fleet-output.sh",
         r'    echo "       set FLEET_OUTPUT_DIR, or put its full path on one line in [^\n]*\n', ''),
        ("the ingest that finds no run no longer says which folder it searched", "C", "ingest-waf-report.ts",
         r'      `       Folder searched: \$\{BACKUPS\}`,\n', ''),
        ("the ingest that finds no run no longer says how to point at another folder", "C", "ingest-waf-report.ts",
         r'      `       set FLEET_OUTPUT_DIR, or put its full path on one line in [^\n]*\n', ''),
        ("the ingest looks for runs in another folder", "C", "ingest-waf-report.ts",
         r'"output-dir"', '"outdir"'),
        ("the apply script looks for the audit somewhere else", "C", "fleet-fail2ban-apply.sh",
         r'ls -d "\$FLEET_OUT"/\*-fail2ban-audit', 'ls -d "$HOME"/audits/*-fail2ban-audit'),
        ("the daily job runs a script outside the repository by default", "D", "waf-refresh.sh",
         r'\$\{WAF_INVENTORY:-\$REPO/scripts/waf-inventory\.py\}', '${WAF_INVENTORY:-$HOME/waf-inventory.py}'),
        ("WAF_INVENTORY no longer names another script", "D", "waf-refresh.sh",
         r'GENERATOR="\$\{WAF_INVENTORY:-\$REPO/scripts/waf-inventory\.py\}"', 'GENERATOR="$REPO/scripts/waf-inventory.py"'),
        ("the daily job removes run folders it did not make", "D", "waf-refresh.sh",
         r"-name '20\?\?-\?\?-\?\?-waf-daily'", "-name '20??-??-??-waf-*'"),
        ("the daily job stops at the first failed inventory again", "D", "waf-refresh.sh",
         r'(if ! python3 "\$GENERATOR" --out "\$OUT"; then\n)    why="the inventory script failed"', r'\1    stop "the inventory script failed"'),
        ("the daily job tries more than twice", "D", "waf-refresh.sh",
         r'\[ "\$attempt" -ge 2 \] && stop', '[ "$attempt" -ge 3 ] && stop'),
        ("the daily job tries again without waiting", "D", "waf-refresh.sh",
         r'  sleep "\$PAUSE"\n', ''),
        ("the daily job's wait is no longer a minute", "D", "waf-refresh.sh",
         r'WAF_REFRESH_RETRY_SECONDS:-60\}', 'WAF_REFRESH_RETRY_SECONDS:-6}'),
        ("the daily job no longer tries again after a refused ingest", "D", "waf-refresh.sh",
         r'    why="the ingest refused this run"\n', '    stop "the ingest refused this run"\n'),
        ("the live apply puts the token among ssh's arguments", "E", "fleet-fail2ban-apply.sh",
         r'\$REMOTE" live "\$\{ARGS\[@\]\}"', '$REMOTE" live "${ARGS[@]}" "$SERVER_TOKEN"'),
        ("the live apply asks for the token under another name", "E", "fleet-fail2ban-apply.sh",
         r'fleet_cf_token "f2b-', 'fleet_cf_token "fail2ban-'),
        ("the token proof prints the token", "E", "fleet-fail2ban-token-proof.sh",
         r'(fleet_cf_token "f2b-[^\n]*\n)', r'\1echo "token: $SERVER_TOKEN"\n'),
        ("the token proof sends without a token", "E", "fleet-fail2ban-token-proof.sh",
         r'SERVER_TOKEN \|\| exit 1', 'SERVER_TOKEN'),
    ]
    print("Breaking a copy of the scripts on purpose. Each line is one run of the part it should fail.")
    caught = 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (what, part, name, find, put) in enumerate(tries):
            copy = copy_tree(TREE, os.path.join(tmp, "broken-%d" % i))
            path = os.path.join(copy, "scripts", name)
            text = open(path).read()
            new, count = re.subn(find, lambda m: m.expand(put) if "\\1" in put else put, text, count=1)
            if count != 1 or new == text:
                print("  MISSED  %s  (the break did not change %s: fix this control)" % (what, name)); continue
            open(path, "w").write(new)
            r = subprocess.run([sys.executable, os.path.abspath(__file__), "--quiet", "--parts", part],
                               env=dict(os.environ, WAFINV_TREE=copy), stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, universal_newlines=True)
            fails = [l for l in r.stdout.splitlines() if l.startswith("  FAIL %s" % part)]
            if r.returncode != 0 and fails:
                caught += 1
                print("  caught  %s  (%d failing in part %s)" % (what, len(fails), part))
            else:
                print("  MISSED  %s  (exit %d, wanted a failure in part %s)" % (what, r.returncode, part))
                for l in r.stdout.splitlines()[-4:]: print("          " + l)
    print("\n%d broken copies: %d caught, %d missed" % (len(tries), caught, len(tries) - caught))
    sys.exit(0 if caught == len(tries) else 1)

if CONTROLS:
    controls()


# ------------------------------------------------------------------------------
# The stand-ins
# ------------------------------------------------------------------------------
T = tempfile.mkdtemp(prefix="wafinv-")
import atexit
atexit.register(lambda: shutil.rmtree(T, ignore_errors=True))
NEW = copy_tree(TREE, os.path.join(T, "tree"))
SCRIPTS = os.path.join(NEW, "scripts")
GEN = os.path.join(SCRIPTS, "waf-inventory.py")
BIN = os.path.join(T, "bin"); os.makedirs(BIN)

def write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)
    return path

CURL_STANDIN = """#!/bin/bash
# Stand-in for curl: writes down what it was started with, hands requests for
# this machine to the real curl, and refuses every other address.
{ printf '%%s\\n' "$@"; echo "--end--"; } >> "$CURL_LOG"
for a in "$@"; do
  case "$a" in
    http://127.0.0.1:*) exec "%s" "$@" ;;
    https://api.cloudflare.com/client/v4/) echo "probe" >> "$CURL_LOG"; exit 0 ;;
    http://*|https://*) echo "stand-in curl: refusing $a" >&2; exit 7 ;;
  esac
done
exit 2
""" % REAL["curl"]
write(os.path.join(BIN, "curl"), CURL_STANDIN, 0o755)
write(os.path.join(BIN, "ssh"), """#!/bin/bash
# Stand-in for ssh: writes down what it was given and reaches nothing.
n=$(( $(cat "$CAP/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CAP/count"
printf '%s\\n' "$@" > "$CAP/call-$n.args"
cat > "$CAP/call-$n.stdin"
if [ -r "${FAKE_SSH_REPLY:-}" ]; then cat "$FAKE_SSH_REPLY"; else echo "ok"; fi
""", 0o755)
for c in ("scp", "rsync", "ssh-add", "sleep"):
    write(os.path.join(BIN, c), "#!/bin/bash\nexit 0\n", 0o755)

RUNPATH = ":".join([BIN, os.path.dirname(REAL["python3"]), os.path.dirname(REAL["node"]), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
CURL_LOG = os.path.join(T, "curl.log")

def home(tag):
    """A fresh made-up home folder."""
    h = os.path.join(T, "home-" + tag)
    os.makedirs(os.path.join(h, ".config", "fleet", "tokens"))
    os.chmod(os.path.join(h, ".config", "fleet", "tokens"), 0o700)
    return h

def run(argv, h, env=None, cwd=None, stdin=None):
    """Run with nothing inherited from the person running this test."""
    e = {"PATH": RUNPATH, "HOME": h, "TMPDIR": os.path.join(T, "tmp"), "CURL_LOG": CURL_LOG, "LC_ALL": "C"}
    e.update(env or {})
    os.makedirs(e["TMPDIR"], exist_ok=True)
    return subprocess.run(argv, env=e, cwd=cwd or NEW, input=stdin, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, universal_newlines=True)

def load_generator():
    spec = importlib.util.spec_from_file_location("waf_inventory_under_test", GEN)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod

def read(path):
    try:
        with open(path) as f: return f.read()
    except OSError:
        return ""


# ------------------------------------------------------------------------------
# A fake Cloudflare API
# ------------------------------------------------------------------------------
class FakeCloudflare:
    """Answers the four reads the inventory makes, from made-up zones."""
    def __init__(self, zones, token, page_size=4):
        self.zones, self.token, self.page_size = zones, token, page_size
        self.seen = []            # (path, whether the right token came with it)
        self.first = {}           # part of a path -> answers to give before the real one
        fake = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                good = self.headers.get("Authorization") == "Bearer " + fake.token
                fake.seen.append((self.path, good))
                status, body = fake.answer(self.path) if good else (403, {"success": False, "errors": [{"code": 9109}]})
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = "http://127.0.0.1:%d/client/v4" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
    def stop(self):
        self.server.shutdown(); self.server.server_close()
    def reset(self):
        self.seen, self.first = [], {}
    def answer(self, path):
        for key, queue in self.first.items():
            if key in path and queue:
                return queue.pop(0)
        u = urlparse(path); p = u.path[len("/client/v4"):]
        none = (404, {"success": False, "errors": [{"code": 10003, "message": "could not find entrypoint ruleset"}]})
        if p == "/zones":
            page = int(dict(x.split("=") for x in u.query.split("&")).get("page", "1"))
            names = sorted(self.zones)
            part = names[(page - 1) * self.page_size: page * self.page_size]
            return 200, {"success": True, "result_info": {"per_page": self.page_size, "total_count": len(names)},
                         "result": [{"id": self.zones[n]["id"], "name": n, "plan": {"name": "Free Website"},
                                     "account": {"name": "Example Account"}, "paused": self.zones[n].get("paused", False)}
                                    for n in part]}
        m = re.match(r"^/zones/([0-9a-f]{32})/(.+)$", p)
        zone = next((z for z in self.zones.values() if m and z["id"] == m.group(1)), None)
        if not zone:
            return 404, {"success": False, "errors": [{"code": 7003}]}
        what = m.group(2)
        if what == "rulesets/phases/http_request_firewall_custom/entrypoint":
            if zone["rules"] is None: return none
            return 200, {"success": True, "result": {"id": "r" + zone["id"][:8], "version": "7",
                         "last_updated": "2026-01-15T10:00:00Z", "rules": [
                             {"id": "rule%d" % i, "description": d, "action": a, "enabled": on, "expression": e,
                              "action_parameters": {"ruleset": "current"} if a == "skip" else None}
                             for i, (d, a, e, on) in enumerate(zone["rules"])]}}
        if what == "rulesets/phases/http_ratelimit/entrypoint":
            if not zone.get("ratelimit"): return none
            return 200, {"success": True, "result": {"rules": [{"id": "rl%d" % i} for i in range(zone["ratelimit"])]}}
        if what == "dns_records":
            # A page at a time, with the count Cloudflare sends alongside
            # (a zone marked dns_count=False leaves the count out).
            q = dict(x.split("=") for x in u.query.split("&")) if u.query else {}
            per, page = int(q.get("per_page", "100")), int(q.get("page", "1"))
            recs = [{"name": n, "type": t, "proxied": px, "content": c} for n, t, px, c in zone["dns"]]
            body = {"success": True, "result": recs[(page - 1) * per: page * per]}
            if zone.get("dns_count", True):
                body["result_info"] = {"page": page, "per_page": per, "count": len(body["result"]), "total_count": len(recs)}
            return 200, body
        return 404, {"success": False, "errors": [{"code": 7003}]}


PLANTED = "Zx9" + "q7Lm2" * 8        # 43 characters: the shape of a key that must never reach a report

def made_up_zones(canon):
    """Nine zones, one for each thing the inventory has to tell apart."""
    w, s, d = canon["wordpress"], canon["static"], canon["dev"]
    skip = ("Good Bots Allow", "skip", "(cf.client.bot)", True)
    def five(c, block=None):
        return [skip, ("Block Web Hosts", "block", block or c["block"], True),
                ("MC Providers", "managed_challenge", c["providers"], True),
                ("MC Aggressive Crawlers", "managed_challenge", c["crawlers"], True),
                ("MC VPNs and WP Login", "managed_challenge", c["vpn"], True)]
    zid = lambda name: hashlib.md5(name.encode()).hexdigest()
    def zone(name, rules, dns, **more):
        z = {"id": zid(name), "rules": rules, "dns": dns}; z.update(more); return z
    proxied = lambda n, addr: [(n, "A", True, addr), ("www." + n, "CNAME", True, n)]
    f = five(w)
    zones = {
        # all five rules, in order, behind a proxied front door
        "alpha.example": zone("alpha.example", f, proxied("alpha.example", "203.0.113.50")),
        # the same rules with 2 and 3 the other way round
        "beta.example": zone("beta.example", [f[0], f[1], f[3], f[2], f[4]], proxied("beta.example", "203.0.113.51")),
        # an extra clause, and in it a value shaped like a key
        "gamma.example": zone("gamma.example",
                              five(w, w["block"] + ' or (http.request.uri.query contains "key=%s")' % PLANTED),
                              proxied("gamma.example", "203.0.113.52")),
        # the static profile, fronted by a site builder
        "delta.example": zone("delta.example",
                              [skip, ("Block Hosting Networks", "block", s["block"], True),
                               ("MC Providers", "managed_challenge", s["other"], True),
                               ("MC Aggressive Crawlers", "managed_challenge", s["crawlers"], True)],
                              [("www.delta.example", "CNAME", False, "ext-sq.squarespace.com")]),
        # the dev profile: rule 1 blocks the crawlers a live site lets through
        "epsilon.example": zone("epsilon.example",
                                [("Block Indexing Bots (dev)", "block", d["noindex"], True)] + five(d)[1:],
                                [("epsilon.example", "A", True, "203.0.113.53")]),
        # rules of its own that match no profile, and no site records at all
        "zeta.example": zone("zeta.example", [("Block old HTTP", "block", '(http.request.version in {"HTTP/1.0"})', True)], []),
        # no rules, and an apex that points straight at a server proxied elsewhere
        "eta.example": zone("eta.example", None, [("eta.example", "A", False, "203.0.113.50")]),
        # the standard, two rate-limit rules, and three kinds of DNS-only record
        "theta.example": zone("theta.example", five(w),
                              [("theta.example", "A", True, "203.0.113.60"),
                               ("www.theta.example", "CNAME", False, "other.example.net"),
                               ("staging.theta.example", "A", False, "203.0.113.77"),
                               ("mail.theta.example", "CNAME", False, "mail.example.org")], ratelimit=2),
        # every clause right, but the block rule after the challenges; and paused
        "iota.example": zone("iota.example", [f[0], f[2], f[3], f[4], f[1]],
                             proxied("iota.example", "203.0.113.54"), paused=True),
    }
    return zones

PAGE = 500            # the records the inventory asks for per request

def big_zones():
    """Four zones with no rules, for the DNS pages alone. Three hold one record
    more than a page: 500 proxied names, then the apex on the second page."""
    zid = lambda name: hashlib.md5(name.encode()).hexdigest()
    def records(name, addr, apex_proxied):
        first = [("www." + name, "CNAME", True, name)] + [("h%03d.%s" % (i, name), "A", True, addr) for i in range(PAGE - 1)]
        return first + [(name, "A", apex_proxied, addr)]
    return {
        # the apex is DNS-only, and it is record 501
        "kappa.example": {"id": zid("kappa.example"), "rules": None, "dns": records("kappa.example", "203.0.113.80", False)},
        # the same size, every record proxied
        "lambda.example": {"id": zid("lambda.example"), "rules": None, "dns": records("lambda.example", "203.0.113.81", True)},
        # as kappa, from an API that sends no count with its pages
        "mu.example": {"id": zid("mu.example"), "rules": None, "dns": records("mu.example", "203.0.113.82", False), "dns_count": False},
        # two records
        "nu.example": {"id": zid("nu.example"), "rules": None, "dns": [("nu.example", "A", True, "203.0.113.83"), ("www.nu.example", "CNAME", True, "nu.example")]},
    }

# zone -> (class, profile, rules, findings, reach)
EXPECT = {
    "alpha.example":   ("standard", "wordpress", 5, 0, "proxied"),
    "beta.example":    ("standard-reordered", "wordpress", 5, 0, "proxied"),
    "gamma.example":   ("variant", "wordpress", 5, 1, "proxied"),
    "delta.example":   ("standard", "static", 4, 0, "platform-front"),
    "epsilon.example": ("standard", "dev", 5, 0, "proxied"),
    "zeta.example":    ("custom", None, 1, 3, "no-site"),
    "eta.example":     ("none", None, 0, 0, "bypass"),
    "theta.example":   ("standard", "wordpress", 5, 1 - 1, "review"),
    "iota.example":    ("variant", "wordpress", 5, 1, "proxied"),
}

def ts_type(text, name):
    """The fields of one `export type <name> = { ... };` in the app's types: (all, required)."""
    m = re.search(r"export type %s = \{\n(.*?)\n\};" % name, text, re.S)
    if not m: return set(), set()
    fields = re.findall(r"^  (\w+)(\??):", m.group(1), re.M)
    return {f for f, _ in fields}, {f for f, q in fields if not q}


# ==============================================================================
# A. The inventory against a fake Cloudflare API
# ==============================================================================
def part_a():
    global PART
    PART = "A"; say("A. the inventory against a fake Cloudflare API")
    gen = load_generator()
    std = write(os.path.join(T, "standard.md"), gen.SAMPLE_STANDARD)
    canon = gen.load_canons(std)
    check("the made-up standard describes all three profiles", sorted(canon) == ["dev", "static", "wordpress"])
    token = "made-up-token-for-the-inventory-0001"
    fake = FakeCloudflare(made_up_zones(canon), token)
    try:
        # --- the main run: the token from a file only its owner can read ---------
        h = home("a-main")
        write(os.path.join(h, ".config", "fleet", "tokens", "cloudflare-all-read.token"), token + "\n", 0o600)
        out = os.path.join(T, "run-main"); open(CURL_LOG, "w").close()
        r = run([REAL["python3"], GEN, "--out", out, "--standard", std], h, {"WAF_API_BASE": fake.base})
        report_text = read(os.path.join(out, "report.json"))
        try: report = json.loads(report_text)
        except ValueError: report = {}
        check("the run finishes and writes report.json", r.returncode == 0 and bool(report), "exit %d: %s" % (r.returncode, (r.stderr or r.stdout).strip()[-160:]))
        check("all nine zones are in the report, from three pages of the zone list",
              sorted(report) == sorted(EXPECT) and sum(1 for p, _ in fake.seen if "/zones?" in p) == 3,
              "%d zones, %d list requests" % (len(report), sum(1 for p, _ in fake.seen if "/zones?" in p)))
        check("every request carried the token (%d requests)" % len(fake.seen),
              len(fake.seen) == 3 + 9 * 3 and all(ok for _, ok in fake.seen), "%d requests, %d with the token" % (len(fake.seen), sum(ok for _, ok in fake.seen)))
        curl_calls = read(CURL_LOG)
        check("the token is in no argument curl was started with (%d starts)" % curl_calls.count("--end--"),
              curl_calls.count("--end--") == len(fake.seen) and token not in curl_calls and "@-" in curl_calls)
        check("the token is in nothing the run printed and not in the report",
              token not in r.stdout and token not in r.stderr and token not in report_text)

        # the shape, held to the app's own types
        types = read(os.path.join(NEW, "lib", "cloudflare-waf.ts"))
        zone_all, zone_req = ts_type(types, "ReportZone"); rule_all, rule_req = ts_type(types, "WafRule")
        reach_all, _ = ts_type(types, "WafReach"); grey_all, grey_req = ts_type(types, "WafGreyRecord")
        check("the app's types could be read (ReportZone %d fields, WafRule %d, WafReach %d)" % (len(zone_all), len(rule_all), len(reach_all)),
              len(zone_req) >= 12 and len(rule_req) >= 8 and len(reach_all) >= 6 and len(grey_req) >= 4)
        bad = []
        nrules = 0
        for name, z in report.items():
            if not zone_req <= set(z) or not set(z) <= zone_all: bad.append("%s: zone keys" % name)
            if not set(z.get("reach", {})) <= reach_all or "reach" not in z.get("reach", {}): bad.append("%s: reach keys" % name)
            for g in z.get("reach", {}).get("grey", []):
                if not grey_req <= set(g) or not set(g) <= grey_all: bad.append("%s: grey record keys" % name)
            for x in z.get("rules", []):
                nrules += 1
                if not rule_req <= set(x) or not set(x) <= rule_all: bad.append("%s: rule keys" % name)
        check("every zone, rule and DNS record carries the fields the app declares, and no other (%d rules)" % nrules,
              not bad and nrules == 35, "; ".join(bad[:3]) or "%d rules" % nrules)
        got = {n: (z.get("klass"), z.get("profile"), z.get("nrules"), len(z.get("findings", [])), z.get("reach", {}).get("reach"))
               for n, z in report.items()}
        for name in sorted(EXPECT):
            check("%s: class, profile, rules, findings and reach" % name, got.get(name) == EXPECT[name],
                  "got %s, wanted %s" % (got.get(name), EXPECT[name]))
        g = report.get("gamma.example", {})
        masked = [x for x in g.get("rules", []) if x.get("expr_masked")]
        check("a value shaped like a key is masked, and the rule says so",
              PLANTED not in report_text and len(masked) == 1 and "<43-char value redacted>" in masked[0]["expr"]
              and "extra clause" in (g.get("findings") or [""])[0])
        check("a block rule after the challenges is a finding on a zone whose clauses all match",
              report.get("iota.example", {}).get("findings") == [gen.BLOCK_AFTER_CHALLENGE] and report["iota.example"]["paused"] is True)
        z = report.get("zeta.example", {})
        check("a zone that matches no profile names the nearest one and what it lacks",
              z.get("nearest") == "static" and z.get("comparable") is False and all(f.startswith("missing ") for f in z.get("findings", ["x"])))
        e = report.get("eta.example", {}).get("reach", {})
        check("an apex pointing at a server proxied in another zone is a bypass, by evidence",
              e.get("grey", [{}])[0].get("cls") == "ours" and e.get("grey_front") == 1)
        t = report.get("theta.example", {})
        check("rate-limit rules, an exposed subdomain and a delegated name are counted",
              t.get("ratelimit_rules") == 2 and t.get("reach", {}).get("grey_other") == 1 and t.get("reach", {}).get("delegated") == 1
              and t.get("reach", {}).get("proxied_names") == ["theta.example"])
        check("no address reaches the report (%d bytes read)" % len(report_text),
              len(report_text) > 5000 and not re.search(r"\b\d{1,3}(\.\d{1,3}){3}\b", report_text))
        check("without a page template no page is written", not os.path.exists(os.path.join(out, "index.html")))

        # the app's own validation, as the ingest runs it
        v = run([REAL["node"], "--experimental-strip-types", "--no-warnings", "scripts/ingest-waf-report.ts", out, "--dry-run"], h)
        check("the ingest's own validation accepts the report", v.returncode == 0 and "validation  passed: 9 zones and 35 expressions" in v.stdout
              and "dry run: nothing written." in v.stdout, (v.stderr or v.stdout).strip()[-200:])
        doctored = os.path.join(T, "run-doctored"); os.makedirs(doctored)
        write(os.path.join(doctored, "report.json"), report_text.replace("<43-char value redacted>", PLANTED))
        v = run([REAL["node"], "--experimental-strip-types", "--no-warnings", "scripts/ingest-waf-report.ts", doctored, "--dry-run"], h)
        check("control: the same report with the value put back is refused", v.returncode != 0 and "NOT INGESTED" in v.stderr and PLANTED not in v.stderr + v.stdout)

        # --- a read that fails ---------------------------------------------------
        fake.reset(); out2 = os.path.join(T, "run-refused")
        theta = made_up_zones(canon)["theta.example"]["id"]
        fake.first = {"/zones/%s/rulesets/phases/http_request_firewall_custom" % theta: [(403, {"success": False, "errors": [{"code": 9109}]})]}
        r = run([REAL["python3"], GEN, "--out", out2, "--standard", std], h, {"WAF_API_BASE": fake.base})
        check("a ruleset that cannot be read stops the run, names the zone and writes no report",
              r.returncode != 0 and "could not read the custom rules for theta.example" in r.stderr
              and not os.path.exists(os.path.join(out2, "report.json")), "exit %d: %s" % (r.returncode, r.stderr.strip()[-120:]))
        fake.reset(); out3 = os.path.join(T, "run-retried")
        fake.first = {"/zones/%s/rulesets/phases/http_request_firewall_custom" % theta: [(502, b"<html>bad gateway</html>")]}
        r = run([REAL["python3"], GEN, "--out", out3, "--standard", std], h, {"WAF_API_BASE": fake.base})
        check("a bad gateway answered once is asked again, and the report is the same file byte for byte",
              r.returncode == 0 and read(os.path.join(out3, "report.json")) == report_text and len(fake.seen) == 3 + 9 * 3 + 1,
              "exit %d, %d requests" % (r.returncode, len(fake.seen)))

        # --- the wrong token, and the wrong address --------------------------------
        fake.reset(); h2 = home("a-wrong")
        r = run([REAL["python3"], GEN, "--out", os.path.join(T, "run-wrong"), "--standard", std], h2,
                {"WAF_API_BASE": fake.base, "FLEET_CF_TOKEN_ALL_READ": "another-made-up-token-0002"})
        check("control: the fake API refuses a token that is not the right one, and the run stops",
              r.returncode != 0 and len(fake.seen) >= 1 and not any(ok for _, ok in fake.seen) and "zone list failed" in r.stderr)
        fake.reset()
        r = run([REAL["python3"], GEN, "--out", os.path.join(T, "run-away"), "--standard", std], h,
                {"WAF_API_BASE": "https://api.example.com/client/v4"})
        check("an address that is not this machine is refused before anything is sent",
              r.returncode != 0 and "Refusing to send a token anywhere else" in r.stderr and not fake.seen, r.stderr.strip()[-120:])
        fake.reset(); h3 = home("a-none")
        r = run([REAL["python3"], GEN, "--out", os.path.join(T, "run-notoken"), "--standard", std], h3, {"WAF_API_BASE": fake.base})
        check("with no token set up, the run stops before any request and says what to set",
              r.returncode != 0 and not fake.seen and "FLEET_CF_TOKEN_ALL_READ" in r.stderr
              and "cloudflare-token-command" in r.stderr and "tokens/cloudflare-all-read.token" in r.stderr)

        # --- no standard: nothing is compared, and nothing reads as standard ---------
        fake.reset(); out4 = os.path.join(T, "run-nostandard")
        r = run([REAL["python3"], GEN, "--out", out4], h, {"WAF_API_BASE": fake.base})
        try: bare = json.loads(read(os.path.join(out4, "report.json")))
        except ValueError: bare = {}
        klasses = sorted(set(z["klass"] for z in bare.values()))
        check("with no standard document, no zone reads as standard or as a variant: 8 not compared, 1 with no rules",
              r.returncode == 0 and klasses == ["custom", "none"] and sum(z["klass"] == "custom" for z in bare.values()) == 8
              and "NO ZONE IS COMPARED" in r.stdout, "exit %d, classes %s" % (r.returncode, klasses))
        check("  ...and the nearest profile is still named, and the late block rule still found",
              bare.get("delta.example", {}).get("nearest") == "static" and bare.get("alpha.example", {}).get("profile") is None
              and bare.get("iota.example", {}).get("findings") == [gen.BLOCK_AFTER_CHALLENGE])
        r = run([REAL["python3"], GEN, "--out", os.path.join(T, "run-missing")], h,
                {"WAF_API_BASE": fake.base, "WAF_STANDARD": os.path.join(T, "not-there.md")})
        check("a standard that is named but missing stops the run", r.returncode != 0 and "is not there" in r.stderr)

        # --- the settings files: the standard, the page, and a command for the token ---
        fake.reset(); h4 = home("a-settings"); out5 = os.path.join(T, "run-settings")
        cfg = os.path.join(h4, ".config", "fleet")
        write(os.path.join(cfg, "waf-standard"), std + "\n", 0o600)
        tpl = write(os.path.join(T, "page.html"), '<html><script id="d" type="application/json">__DATA__</script></html>')
        write(os.path.join(cfg, "waf-page-template"), tpl + "\n", 0o600)
        write(os.path.join(BIN, "tokcmd"), '#!/bin/bash\necho "$@" >> "%s"\necho "%s"\n' % (os.path.join(T, "tokcmd.log"), token), 0o755)
        write(os.path.join(cfg, "cloudflare-token-command"), "# my password manager\ntokcmd cloudflare-{name}.token\n", 0o600)
        r = run([REAL["python3"], GEN, "--out", out5], h4, {"WAF_API_BASE": fake.base})
        check("the standard named in ~/.config/fleet/waf-standard is used, and the report is the same file",
              r.returncode == 0 and read(os.path.join(out5, "report.json")) == report_text, "exit %d %s" % (r.returncode, r.stderr.strip()[-120:]))
        check("the token command is asked for the token by name", read(os.path.join(T, "tokcmd.log")).split() == ["cloudflare-all-read.token"])
        page = read(os.path.join(out5, "index.html"))
        m = re.search(r'<script id="d" type="application/json">(.*)</script>', page, re.S)
        try: data = json.loads(m.group(1)) if m else {}
        except ValueError: data = {}
        check("a page template named in the settings is filled with the same report",
              data.get("zones") == report and data.get("counts", {}).get("standard") == 4 and token not in page)

        # --- the inventory's own offline checks ----------------------------------
        r = run([REAL["python3"], GEN, "--selftest"], h3)
        n = len(re.findall(r"^  PASS  ", r.stdout, re.M))
        check("the inventory's own offline checks pass (%d of them)" % n,
              r.returncode == 0 and n >= 100 and "  FAIL  " not in r.stdout and "all checks passed" in r.stdout)
    finally:
        fake.stop()

    # --- a zone with more DNS records than one page holds ------------------------
    zones = big_zones(); kappa = zones["kappa.example"]["id"]
    big = FakeCloudflare(zones, token, page_size=50)
    def reaches(folder):
        try: rep = json.loads(read(os.path.join(folder, "report.json")))
        except ValueError: rep = {}
        return {n: z.get("reach", {}).get("reach") for n, z in rep.items()}
    try:
        h = home("a-pages")
        write(os.path.join(h, ".config", "fleet", "tokens", "cloudflare-all-read.token"), token + "\n", 0o600)
        out = os.path.join(T, "run-pages")
        r = run([REAL["python3"], GEN, "--out", out], h, {"WAF_API_BASE": big.base})
        got = reaches(out); whole = read(os.path.join(out, "report.json"))
        dns = [p for p, _ in big.seen if "/dns_records" in p]
        check("control: the made-up zones hold one record more than a page (%d records, %d a page)" % (len(zones["kappa.example"]["dns"]), PAGE),
              len(zones["kappa.example"]["dns"]) == PAGE + 1 and zones["kappa.example"]["dns"][PAGE][2] is False
              and all(px for _, _, px, _ in zones["kappa.example"]["dns"][:PAGE]) and any("per_page=%d&" % PAGE in p for p in dns))
        check("a DNS-only apex on the second page of a zone's records is found: the zone is a bypass, not proxied",
              r.returncode == 0 and got.get("kappa.example") == "bypass", "exit %d, kappa reads %s" % (r.returncode, got.get("kappa.example")))
        check("  ...the same when the API sends no count with its pages", got.get("mu.example") == "bypass", "mu reads %s" % got.get("mu.example"))
        check("control: a zone that size with every record proxied still reads as proxied, and so does a small one",
              got.get("lambda.example") == "proxied" and got.get("nu.example") == "proxied", str(got))
        check("every page was asked for, and no more: 2, 2, 3 (no count, so on to an empty page) and 1 (%d DNS requests)" % len(dns),
              [sum(1 for p in dns if zones[n]["id"] in p) for n in sorted(zones)] == [2, 2, 3, 1] and all(ok for _, ok in big.seen),
              str([sum(1 for p in dns if zones[n]["id"] in p) for n in sorted(zones)]))

        big.reset(); out2 = os.path.join(T, "run-pages-refused")
        big.first = {"/zones/%s/dns_records?per_page=%d&page=2" % (kappa, PAGE): [(403, {"success": False, "errors": [{"code": 9109}]})]}
        r = run([REAL["python3"], GEN, "--out", out2], h, {"WAF_API_BASE": big.base})
        got = reaches(out2)
        check("a second page that cannot be read is a failed read for that zone: unknown, never the first page alone",
              r.returncode == 0 and got.get("kappa.example") == "unknown" and "DNS unreadable on 1 zone(s): kappa.example" in r.stdout,
              "exit %d, kappa reads %s" % (r.returncode, got.get("kappa.example")))
        check("  ...and the other zones are read as before", {n: v for n, v in got.items() if n != "kappa.example"}
              == {"lambda.example": "proxied", "mu.example": "bypass", "nu.example": "proxied"}, str(got))

        big.reset(); out3 = os.path.join(T, "run-pages-retried")
        big.first = {"/zones/%s/dns_records?per_page=%d&page=2" % (kappa, PAGE): [(502, b"<html>bad gateway</html>")]}
        r = run([REAL["python3"], GEN, "--out", out3], h, {"WAF_API_BASE": big.base})
        check("a second page that fails once is asked again, and the report is the same file byte for byte",
              r.returncode == 0 and bool(whole) and read(os.path.join(out3, "report.json")) == whole
              and sum(1 for p, _ in big.seen if "/dns_records" in p) == 9, "exit %d" % r.returncode)
    finally:
        big.stop()


# ==============================================================================
# B. Where a token is looked for
# ==============================================================================
SHELL_LOOKUP = '. "$1/lib-fleet-token.sh"; fleet_cf_token "$2" TOK; rc=$?; printf "%s\\n%s\\n%s" "$rc" "$TOK" "$FLEET_CF_TOKEN_SOURCE" >&3'
PY_LOOKUP = """
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("inv", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = os.fdopen(3, "w")
try:
    out.write("0\\n" + m.cf_token(sys.argv[2]) + "\\n")
except SystemExit as e:
    sys.stderr.write(str(e) + "\\n"); out.write("1\\n\\n")
"""

def lookup(kind, h, name, env=None):
    """Ask the shell or the inventory for a token. Returns (exit, value, what was printed, what was said)."""
    res = os.path.join(T, "lookup.out"); open(res, "w").close()
    e = {"PATH": RUNPATH, "HOME": h, "LC_ALL": "C"}; e.update(env or {})
    argv = ([REAL["bash"], "-uc", SHELL_LOOKUP, "lookup", SCRIPTS, name] if kind == "shell"
            else [REAL["python3"], "-c", PY_LOOKUP, GEN, name])
    # File descriptor 3 carries the answer, so that standard output can be checked for silence.
    r = subprocess.run([REAL["bash"], "-c", 'exec 3> "$0"; exec "$@"', res] + argv, env=e, cwd=NEW,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    lines = (read(res) + "\n\n").split("\n")
    return lines[0], lines[1], r.stdout, r.stderr

def part_b():
    global PART
    PART = "B"; say("B. where a token is looked for: the shell and the inventory, side by side")
    log = os.path.join(T, "cmd.log")
    def command(text="cmd-token-value-0000001", rc=0):
        write(os.path.join(BIN, "mytokens"), '#!/bin/bash\necho "$@" >> "%s"\nprintf \'%%s\\n\' "%s"\nexit %d\n' % (log, text, rc), 0o755)
    def setup(tag, file=None, file_mode=0o600, cmd=None, cmd_mode=0o600, xdg=False):
        h = home("b-" + tag)
        cfg = os.path.join(h, "elsewhere", "fleet") if xdg else os.path.join(h, ".config", "fleet")
        if file is not None:
            write(os.path.join(cfg, "tokens", "cloudflare-all-read.token"), file, file_mode)
        if cmd is not None:
            write(os.path.join(cfg, "cloudflare-token-command"), cmd, cmd_mode)
        open(log, "w").close()
        return h
    FILE, CMD, ENV = "file-token-value-0000001", "cmd-token-value-0000001", "env-token-value-0000001"
    USES = "mytokens show cloudflare/{name}\n"
    command()

    def both(label, h, want_rc, want_value, said=None, env=None, name="all-read", secret=None):
        """One made-up setup, asked both ways. The two must agree with each other and with what is wanted."""
        res = {k: lookup(k, h, name, env) for k in ("shell", "inventory")}
        for k, (rc, value, printed, err) in sorted(res.items()):
            ok = rc == want_rc and value == want_value and printed == ""
            if said: ok = ok and said in err
            for s in [secret] if secret else [FILE, CMD, ENV]:
                ok = ok and s not in err and s not in printed
            check("%s: %s" % (k, label), ok, "exit %s, %d characters, said: %s" % (rc, len(value), err.strip().replace("\n", " ")[:110]))
        return res

    h = setup("none")
    r = both("nothing set up: it stops", h, "1", "", said="no Cloudflare token \"all-read\" is set up")
    for k in sorted(r):
        err = r[k][3]
        check("%s:   ...and says exactly what to set: the variable, the command file and the token file" % k,
              "FLEET_CF_TOKEN_ALL_READ" in err and os.path.join(h, ".config", "fleet", "cloudflare-token-command") in err
              and os.path.join(h, ".config", "fleet", "tokens", "cloudflare-all-read.token") in err and "chmod 600" in err)
    both("a file only its owner can read: its value is used", setup("file", file=FILE + "\n"), "0", FILE)
    both("a file that ends with a Windows line ending is read the same", setup("crlf", file=FILE + "\r\n"), "0", FILE)
    both("a file others can read is refused, and the fix is named", setup("f644", file=FILE, file_mode=0o644), "1", "", said="chmod 600")
    both("a file the group can read is refused too", setup("f640", file=FILE, file_mode=0o640), "1", "", said="only you can read")
    both("an empty file is not a token", setup("empty", file="\n"), "1", "", said="empty value")
    h = setup("cmd", file=FILE, cmd=USES)
    both("a command and a file: the command wins", h, "0", CMD)
    check("  ...and the command was run with the token's name where {name} was", read(log).split("\n")[:2] == ["show cloudflare/all-read"] * 2, read(log)[:80])
    h = setup("env", file=FILE, cmd=USES)
    both("the environment, a command and a file: the environment wins", h, "0", ENV, env={"FLEET_CF_TOKEN_ALL_READ": ENV})
    check("  ...and the command was not run at all", read(log) == "")
    both("a command file that holds only comments is no command: the file is used",
         setup("comment", file=FILE, cmd="# nothing here yet\n\n"), "0", FILE)
    command(rc=3)
    both("a command that fails stops the run; the file is not tried", setup("fails", file=FILE, cmd=USES), "1", "", said="the token command failed (exit 3)")
    command()
    both("a command that is not installed stops the run", setup("absent", file=FILE, cmd="no-such-tool {name}\n"), "1", "", said="is not on the PATH")
    both("a command file other people can change is not run", setup("c666", file=FILE, cmd=USES, cmd_mode=0o666), "1", "", said="someone else can change it")
    check("  ...the command really was not run", read(log) == "")
    command(text="two words")
    both("a command that prints something else is refused, and what it printed is not repeated",
         setup("junk", cmd=USES), "1", "", said="not one API token", secret="two words")
    command()
    QUOTED = "has'quote-0000000000001"
    both("a value with a quote in it is refused (it would end the text sent to a server early)",
         setup("quote"), "1", "", said="23 characters that are not one API token", env={"FLEET_CF_TOKEN_ALL_READ": QUOTED}, secret=QUOTED)
    both("a server's token has its own variable", setup("f2b"), "0", ENV, env={"FLEET_CF_TOKEN_F2B_WEB1": ENV}, name="f2b-web1")
    both("  ...and is not found under another server's", setup("f2b2"), "1", "", env={"FLEET_CF_TOKEN_F2B_WEB1": ENV}, name="f2b-web2", said="FLEET_CF_TOKEN_F2B_WEB2")
    both("a dot in a server's label becomes _ in the variable", setup("dot"), "0", ENV, env={"FLEET_CF_TOKEN_F2B_WEB_1": ENV}, name="f2b-web.1")
    both("a name that is not a token name is refused", setup("name", file=FILE), "1", "", name="All Read", said="is not a token name")
    h = setup("xdg", file=FILE, xdg=True)
    both("the settings follow XDG_CONFIG_HOME", h, "0", FILE, env={"XDG_CONFIG_HOME": os.path.join(h, "elsewhere")})
    both("control:   ...and are not found without it", h, "1", "")


# ==============================================================================
# C. The output folder
# ==============================================================================
SERVERS = "203.0.113.21|101|web1|golden\n203.0.113.22|102|Web_2\n"
DRY_REPLY = ("dry_run_complete=yes\nconfig_test=ok\nhelper_syntax=ok\nhelper_needs python3=yes 3\ncontrol=ok\n"
             "sample a ok\nsample b ok\nsample c ok\n")

def fixtures():
    write(os.path.join(T, "fx", "servers"), SERVERS)
    write(os.path.join(T, "fx", "reply-dry"), DRY_REPLY)
    return {"FLEET_SERVERS_FILE": os.path.join(T, "fx", "servers")}

def audit_and_report(folder, zone_id):
    """What the apply script needs to find: two audits (the later one complete) and an inventory."""
    write(os.path.join(folder, "2026-01-01-fail2ban-audit", "web1.txt"), "site=old.example.com wp=yes\n")
    write(os.path.join(folder, "2026-01-02-fail2ban-audit", "web1.txt"), "site=shop.example.com wp=yes\naudit_complete=yes\n")
    write(os.path.join(folder, "2026-01-02-fail2ban-audit", "Web_2.txt"), "site=shop.example.com wp=yes\naudit_complete=yes\n")
    write(os.path.join(folder, "2026-01-02-waf-daily", "waf-inventory", "report.json"),
          json.dumps({"example.com": {"zone_id": zone_id, "reach": {"reach": "proxied"}}}))

def part_c():
    global PART
    PART = "C"; say("C. the output folder: one setting, read the same way everywhere")
    fx = fixtures()
    code = lambda name: "\n".join(l for l in read(os.path.join(SCRIPTS, name)).split("\n") if not l.lstrip().startswith("#"))
    missing = [s for s in FOLDER_SCRIPTS if read(os.path.join(SCRIPTS, s)).count(FOLDER_LINE) != 1
               or len(re.findall(r"FLEET_OUT=", read(os.path.join(SCRIPTS, s)))) != 1]
    check("the %d scripts that keep something on this machine all read the folder with the same one line: the shared function" % len(FOLDER_SCRIPTS),
          not missing, "not in: " + " ".join(missing))
    shells = [f for f in sorted(os.listdir(SCRIPTS)) if f.endswith(".sh") and not f.startswith("test-") and "selftest" not in f]
    own_way = [f for f in shells if f != FOLDER_LIB and re.search(FOLDER_PIECES, code(f))]
    check("no other shell script reads the setting for itself: only %s names the variable or the file (%d scripts read)" % (FOLDER_LIB, len(shells)),
          not own_way and len(shells) >= 20 and len(re.findall(FOLDER_PIECES, code(FOLDER_LIB))) >= 2, " ".join(own_way))
    callers = sorted(f for f in shells if "fleet_output_dir" in code(f) and f != FOLDER_LIB)
    check("the function is called by those %d scripts and no other" % len(FOLDER_SCRIPTS), callers == sorted(FOLDER_SCRIPTS), " ".join(callers))
    own = []
    for f in sorted(os.listdir(SCRIPTS)):
        if f.startswith("test-") or not f.endswith((".sh", ".ts", ".py", ".mjs")): continue
        if re.search(r'\$HOME"?/Projects|~/Projects|homedir\(\), "Projects"', read(os.path.join(SCRIPTS, f))): own.append(f)
    check("no script keeps its output in a folder of its own under ~/Projects (%d scripts read)" % len([f for f in os.listdir(SCRIPTS) if f.endswith((".sh", ".ts", ".py", ".mjs"))]),
          not own, " ".join(own))

    # The shell function and the ingest's TypeScript, asked on the same made-up
    # settings. The ingest is asked through --latest on a folder with no run in
    # it: its refusal names the folder it searched, on a line of its own.
    def shell_folder(h2, env=None):
        r = run([REAL["bash"], "-uc", '. "$1/%s" || exit 9; fleet_output_dir' % FOLDER_LIB, "folder", SCRIPTS], h2, env)
        return r.stdout if r.returncode == 0 else "exit %d: %s" % (r.returncode, r.stderr.strip()[-80:])
    def ingest_folder(h2, env=None):
        r = run([REAL["node"], "--experimental-strip-types", "--no-warnings", "scripts/ingest-waf-report.ts", "--latest", "--dry-run"], h2, env)
        m = re.search(r"^       Folder searched: (.*)$", r.stderr, re.M)
        return m.group(1) if m and r.returncode != 0 else "not said: " + (r.stderr or r.stdout).strip()[-80:]
    def setting(tag, line=None, where=".config"):
        h2 = home("c-set-" + tag)
        if line is not None:
            write(os.path.join(h2, where, "fleet", "output-dir"), line, 0o600)
        return h2
    h = setting("none")
    spaced = os.path.join(h, "my runs", "kept here")
    cases = [  # (what, the home folder, the environment, the folder both must name)
        ("nothing set: ~/.local/state/fleet", h, None, os.path.join(h, ".local", "state", "fleet")),
        ("XDG_STATE_HOME moves the default", h, {"XDG_STATE_HOME": os.path.join(h, "state dir")}, os.path.join(h, "state dir", "fleet")),
        ("FLEET_OUTPUT_DIR is used", h, {"FLEET_OUTPUT_DIR": os.path.join(h, "from-env")}, os.path.join(h, "from-env")),
        ("FLEET_OUTPUT_DIR with spaces in it is used whole", h, {"FLEET_OUTPUT_DIR": spaced}, spaced),
        ("FLEET_OUTPUT_DIR wins over XDG_STATE_HOME", h, {"FLEET_OUTPUT_DIR": os.path.join(h, "from-env"), "XDG_STATE_HOME": os.path.join(h, "state dir")}, os.path.join(h, "from-env")),
    ]
    h = setting("file", spaced + "\n")
    cases += [
        ("a path in ~/.config/fleet/output-dir is used, spaces and all", h, None, spaced),
        ("FLEET_OUTPUT_DIR wins over the file", h, {"FLEET_OUTPUT_DIR": os.path.join(h, "from-env")}, os.path.join(h, "from-env")),
        ("an empty FLEET_OUTPUT_DIR is no setting: the file is used", h, {"FLEET_OUTPUT_DIR": ""}, spaced),
        ("the file wins over XDG_STATE_HOME", h, {"XDG_STATE_HOME": os.path.join(h, "state dir")}, spaced),
        ("the settings file follows XDG_CONFIG_HOME: one that is not there means the default", h,
         {"XDG_CONFIG_HOME": os.path.join(h, "none")}, os.path.join(h, ".local", "state", "fleet")),
    ]
    h = setting("xdg", os.path.join(T, "kept by xdg") + "\n", where="elsewhere")
    cases.append(("a file under XDG_CONFIG_HOME is used", h, {"XDG_CONFIG_HOME": os.path.join(h, "elsewhere")}, os.path.join(T, "kept by xdg")))
    h = setting("bare", os.path.join(T, "no line end"))
    cases.append(("a file with no line break at its end is read the same", h, None, os.path.join(T, "no line end")))
    h = setting("blank", os.path.join(T, "blank after") + "\n\n\n")
    cases.append(("blank lines after the path are not part of it", h, None, os.path.join(T, "blank after")))
    h = setting("empty", "\n")
    cases.append(("an empty settings file is no setting: the default", h, None, os.path.join(h, ".local", "state", "fleet")))
    for what, h2, env, want in cases:
        sh, ts = shell_folder(h2, env), ingest_folder(h2, env)
        check("shell and ingest agree: %s" % what, sh == want and ts == want,
              "shell %s the wanted folder, ingest %s it; they %s" % ("names" if sh == want else "does not name", "names" if ts == want else "does not name", "agree" if sh == ts else "disagree"))
    check("control: the two were asked %d times each, and the folders asked for differ (%d different)" % (len(cases), len(set(c[3] for c in cases))),
          len(cases) >= 12 and len(set(c[3] for c in cases)) >= 8)
    h = home("c")
    folder = lambda env=None: shell_folder(h, env)
    mine = os.path.join(h, "my runs")
    write(os.path.join(h, ".config", "fleet", "output-dir"), mine + "\n", 0o600)
    r = run([REAL["bash"], "-uc", FOLDER_LINE + '; printf %s "$FLEET_OUT"', os.path.join(SCRIPTS, "waf-refresh.sh")], h)
    check("the one line, run as a script runs it, sets the folder the function names", r.stdout == mine and folder() == mine, r.stdout or r.stderr.strip()[-80:])
    r = run([REAL["bash"], "-uc", FOLDER_LINE + '; echo "went on with: $FLEET_OUT"', os.path.join(T, "nowhere", "waf-refresh.sh")], h)
    check("control: without the library beside it, the line stops the script instead of going on with no folder",
          r.returncode != 0 and "went on" not in r.stdout, "exit %d" % r.returncode)

    # The ingest finds the newest run in the same folder, each way it can be set.
    zid = "ab" * 16
    def ingest_latest(h2, env=None):
        r = run([REAL["node"], "--experimental-strip-types", "--no-warnings", "scripts/ingest-waf-report.ts", "--latest", "--dry-run"], h2, env)
        m = re.search(r"^report\s+(.*)$", r.stdout, re.M)
        n = re.search(r"^run\s+(.*)$", r.stdout, re.M)
        return (m.group(1) if m else "none: " + (r.stderr or r.stdout).strip()[-90:]), (n.group(1) if n else "")
    full = {"example.com": {"zone_id": zid, "plan": "Free Website", "acct": "Example Account", "paused": False, "nrules": 0,
                            "ratelimit_rules": 0, "version": None, "updated": "", "klass": "none", "core_fp": None,
                            "order_matches": True, "findings": [], "reach": {"reach": "proxied"}, "rules": []}}
    today = time.strftime("%Y-%m-%d")
    places = {"the default folder": (home("c-default"), None, None),
              "the folder in the settings file": (home("c-file"), "file", None),
              "the folder in FLEET_OUTPUT_DIR": (home("c-env"), None, "env")}
    for label, (h2, by_file, by_env) in sorted(places.items()):
        where = os.path.join(h2, ".local", "state", "fleet")
        env = None
        if by_file:
            where = os.path.join(h2, "kept"); write(os.path.join(h2, ".config", "fleet", "output-dir"), where + "\n", 0o600)
        if by_env:
            where = os.path.join(h2, "from-env"); env = {"FLEET_OUTPUT_DIR": where}
        write(os.path.join(where, today + "-waf-daily", "waf-inventory", "report.json"), json.dumps(full))
        got, rundir = ingest_latest(h2, env)
        check("the ingest finds the newest run in %s, and names the run by its place in that folder" % label,
              got == os.path.join(where, today + "-waf-daily", "waf-inventory", "report.json")
              and rundir == today + "-waf-daily/waf-inventory", got)

    # Earlier runs kept in another folder, and nothing set: each lookup finds
    # nothing in the default folder. It must say which folder it searched and how
    # to point at another one, and pointing at it must then work.
    HOW = "If earlier runs, audits or snapshots are kept in another folder, point at it:"
    def says_where(text, searched, h2, origin, cfg=None):
        cfg = cfg or os.path.join(h2, ".config", "fleet", "output-dir")
        return ("       Folder searched: %s\n       (%s)\n" % (searched, origin) in text and "       " + HOW + "\n" in text
                and "       set FLEET_OUTPUT_DIR, or put its full path on one line in %s.\n" % cfg in text)
    NOT_SET = "the default: no other folder is set"
    h2 = home("c-moved"); default = os.path.join(h2, ".local", "state", "fleet"); earlier = os.path.join(h2, "earlier runs")
    audit_and_report(earlier, zid)
    write(os.path.join(earlier, "2026-01-02-waf-daily", "waf-inventory", "report.json"), json.dumps(full))
    snap = os.path.join(earlier, "2026-01-02-server-snapshots", "web1"); write(os.path.join(snap, "manifest.json"), "{}")
    cap = os.path.join(T, "cap-c-moved"); os.makedirs(cap)
    env = dict(fx, CAP=cap, FAKE_SSH_REPLY=os.path.join(T, "fx", "reply-dry"))
    point_env = dict(env, FLEET_OUTPUT_DIR=earlier)

    r = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1"], h2, env)
    check("a restore that finds no snapshot says which folder it searched, that nothing is set, and three ways to point at another",
          r.returncode == 1 and "ABORT: no snapshot found for web1.\n" in r.stdout and says_where(r.stdout, default, h2, NOT_SET)
          and "--snapshot <path>" in r.stdout, r.stdout.strip()[-200:])
    check("  ...it does not send you to the old server as the only way out, and it connected to nothing",
          "on the old server first" not in r.stdout and "still answers" in r.stdout and not os.path.exists(os.path.join(cap, "count")))
    r = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1"], h2, point_env)
    check("  ...and with FLEET_OUTPUT_DIR pointed at the other folder, the snapshot there is the one used",
          "snapshot: %s " % snap in r.stdout and "no snapshot found" not in r.stdout, r.stdout.strip()[:160])
    r = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1", "--snapshot", snap], h2, env)
    check("  ...and so is one named with --snapshot", "snapshot: %s " % snap in r.stdout and "no snapshot found" not in r.stdout, r.stdout.strip()[:160])
    r = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1", "--snapshot", earlier], h2, env)
    check("control: a folder named with --snapshot that holds no snapshot is refused in its own words, with no talk of other folders",
          r.returncode == 1 and "ABORT: %s holds no whole snapshot" % earlier in r.stdout and "Folder searched" not in r.stdout, r.stdout.strip()[-160:])

    r = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1"], h2, env)
    check("the apply script that finds no audit says which folder it searched, that nothing is set, and how to point at another",
          r.returncode == 1 and "ABORT: no Fail2Ban audit found.\n" in r.stdout and says_where(r.stdout, default, h2, NOT_SET)
          and "F2B_AUDIT_OUT" in r.stdout and "/web1.txt" not in r.stdout, r.stdout.strip()[-200:])
    write(os.path.join(default, "2026-01-03-fail2ban-audit", "web1.txt"), "site=shop.example.com wp=yes\naudit_complete=yes\n")
    r = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1"], h2, env)
    check("  ...and the same when it is the Cloudflare inventory that is not there",
          r.returncode == 1 and "ABORT: no Cloudflare inventory (report.json) found.\n" in r.stdout and says_where(r.stdout, default, h2, NOT_SET)
          and "WAF_REPORT" in r.stdout, r.stdout.strip()[-200:])
    r = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1"], h2, point_env)
    check("  ...and with FLEET_OUTPUT_DIR pointed at the other folder, the audit and the inventory there are the ones used",
          "audit: %s" % os.path.join(earlier, "2026-01-02-fail2ban-audit", "web1.txt") in r.stdout
          and "inventory: %s" % os.path.join(earlier, "2026-01-02-waf-daily", "waf-inventory", "report.json") in r.stdout and "dry run clean" in r.stdout,
          (r.stdout + r.stderr).strip()[-160:])

    latest = [REAL["node"], "--experimental-strip-types", "--no-warnings", "scripts/ingest-waf-report.ts", "--latest", "--dry-run"]
    r = run(latest, h2)
    check("the ingest's --latest that finds no run says which folder it searched, that nothing is set, and how to point at another",
          r.returncode == 1 and "NOT INGESTED: no inventory run found.\n" in r.stderr and says_where(r.stderr, default, h2, NOT_SET)
          and "in place of --latest" in r.stderr, r.stderr.strip()[-200:])
    h3 = home("c-nofolder")
    r = run(latest, h3)
    check("  ...the same when the folder is not there at all",
          r.returncode == 1 and says_where(r.stderr, os.path.join(h3, ".local", "state", "fleet"), h3, NOT_SET) and "no such folder" not in r.stderr, r.stderr.strip()[-200:])
    cfg = os.path.join(h2, ".config", "fleet", "output-dir")
    write(cfg, earlier + "\n", 0o600)
    r = run(latest + ["--generated", "2026-01-02T12:00:00Z"], h2)
    check("  ...and with the other folder's path in the settings file, the run there is the one found",
          r.returncode == 0 and re.search(r"^report\s+%s$" % re.escape(os.path.join(earlier, "2026-01-02-waf-daily", "waf-inventory", "report.json")), r.stdout, re.M) is not None,
          (r.stderr or r.stdout).strip()[-160:])
    # A folder that is set, and empty: the message says where the setting came from.
    empty = os.path.join(h2, "nothing here"); os.makedirs(empty)
    write(cfg, empty + "\n", 0o600)
    r1 = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1"], h2, env); r2 = run(latest, h2)
    check("a folder named in the settings file is the one searched, and both the shell and the ingest say the file named it",
          says_where(r1.stdout, empty, h2, "set in %s" % cfg) and says_where(r2.stderr, empty, h2, "set in %s" % cfg), (r1.stdout + r2.stderr).strip()[-200:])
    there = os.path.join(h2, "not made yet")
    r1 = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1"], h2, dict(env, FLEET_OUTPUT_DIR=there)); r2 = run(latest, h2, {"FLEET_OUTPUT_DIR": there})
    check("a folder named in FLEET_OUTPUT_DIR is the one searched, and both say the variable named it",
          says_where(r1.stdout, there, h2, "set in FLEET_OUTPUT_DIR") and says_where(r2.stderr, there, h2, "set in FLEET_OUTPUT_DIR"), (r1.stdout + r2.stderr).strip()[-200:])
    other_cfg = os.path.join(h2, "elsewhere", "fleet", "output-dir")
    r1 = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1"], h2, dict(env, XDG_CONFIG_HOME=os.path.join(h2, "elsewhere")))
    r2 = run(latest, h2, {"XDG_CONFIG_HOME": os.path.join(h2, "elsewhere")})
    check("with XDG_CONFIG_HOME set, the settings file both name is the one under it",
          says_where(r1.stdout, default, h2, NOT_SET, other_cfg) and says_where(r2.stderr, default, h2, NOT_SET, other_cfg), (r1.stdout + r2.stderr).strip()[-200:])
    worded = []
    for f in sorted(os.listdir(SCRIPTS)):
        if f.endswith((".sh", ".ts", ".py", ".mjs")) and not f.startswith("test-") and re.search(r"Folder searched|fleet_output_dir_hint|noRunFound", read(os.path.join(SCRIPTS, f))):
            worded.append(f)
    check("the %d files that word or print that message are the library, the two shell scripts and the ingest" % len(worded),
          worded == sorted([FOLDER_LIB, "fleet-fail2ban-apply.sh", "fleet-server-restore.sh", "ingest-waf-report.ts"]), " ".join(worded))

    # The Fail2Ban scripts and the snapshot: found and written under the same folder.
    for label, by_file in (("the default folder", False), ("the folder in the settings file", True)):
        h2 = home("c-f2b-" + ("file" if by_file else "default"))
        where = os.path.join(h2, ".local", "state", "fleet")
        if by_file:
            where = os.path.join(h2, "kept"); write(os.path.join(h2, ".config", "fleet", "output-dir"), where + "\n", 0o600)
        audit_and_report(where, zid)
        cap = os.path.join(T, "cap-c-" + ("file" if by_file else "default")); os.makedirs(cap)
        env = dict(fx, CAP=cap, FAKE_SSH_REPLY=os.path.join(T, "fx", "reply-dry"))
        r = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1"], h2, env)
        check("the apply script takes the latest audit and the inventory from %s" % label,
              "audit: %s" % os.path.join(where, "2026-01-02-fail2ban-audit", "web1.txt") in r.stdout
              and "inventory: %s" % os.path.join(where, "2026-01-02-waf-daily", "waf-inventory", "report.json") in r.stdout
              and "dry run clean" in r.stdout, (r.stdout + r.stderr).strip()[-160:])
        env = dict(fx, CAP=cap)
        r = run([REAL["bash"], "scripts/fleet-fail2ban.sh", "web1"], h2, env)
        d = os.path.join(where, today + "-fail2ban-audit")
        check("the audit writes today's folder under %s, for its owner only" % label,
              os.path.isdir(d) and stat.S_IMODE(os.stat(d).st_mode) == 0o700, (r.stdout + r.stderr).strip()[-120:])
        r = run([REAL["bash"], "scripts/fleet-server-snapshot.sh", "web1"], h2, env)
        d = os.path.join(where, today + "-server-snapshots")
        check("a snapshot writes today's folder under %s, for its owner only" % label,
              os.path.isdir(d) and stat.S_IMODE(os.stat(d).st_mode) == 0o700, (r.stdout + r.stderr).strip()[-120:])
        r = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1"], h2, env)
        check("control: a restore finds no snapshot there yet, and says so", r.returncode != 0 and "no snapshot found for web1" in r.stdout)
        write(os.path.join(where, "2026-01-02-server-snapshots", "web1", "manifest.json"), "{}")
        r = run([REAL["bash"], "scripts/fleet-server-restore.sh", "web1"], h2, env)
        check("a restore finds the snapshot under %s" % label, "no snapshot found" not in r.stdout + r.stderr)


# ==============================================================================
# D. The daily job, end to end, with --dry-run
# ==============================================================================
def part_d():
    global PART
    PART = "D"; say("D. scripts/waf-refresh.sh from end to end (--dry-run: nothing is written to a database)")
    gen = load_generator()
    std = write(os.path.join(T, "standard-d.md"), gen.SAMPLE_STANDARD)
    token = "made-up-token-for-the-daily-job-0003"
    fake = FakeCloudflare(made_up_zones(gen.load_canons(std)), token)
    today = time.strftime("%Y-%m-%d")
    waits = lambda h: read(os.path.join(h, "waits.log")).split("\n")[:-1]     # each wait the job asked for, in seconds
    lists = lambda: sum(1 for p, _ in fake.seen if "/zones?" in p and "page=1" in p)   # inventories started
    report_in = lambda h: os.path.join(h, ".local", "state", "fleet", today + "-waf-daily", "waf-inventory", "report.json")
    refusal = (403, {"success": False, "errors": [{"code": 9109}]})
    def daily_home(tag, with_token=True):
        h = home("d-" + tag)
        # The job puts ~/.local/bin first on its PATH, so the stand-in curl goes there,
        # and a stand-in sleep that writes down how long it was asked to wait and does not.
        os.makedirs(os.path.join(h, ".local", "bin")); shutil.copy(os.path.join(BIN, "curl"), os.path.join(h, ".local", "bin", "curl"))
        write(os.path.join(h, ".local", "bin", "sleep"), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$HOME/waits.log"\n', 0o755)
        write(os.path.join(h, ".config", "fleet", "waf-standard"), std + "\n", 0o600)
        if with_token:
            write(os.path.join(h, ".config", "fleet", "tokens", "cloudflare-all-read.token"), token + "\n", 0o600)
        return h
    try:
        h = daily_home("main"); state = os.path.join(h, ".local", "state", "fleet")
        old = os.path.join(state, "2020-01-01-waf-daily"); byhand = os.path.join(state, "2020-01-01-waf-by-hand")
        for d in (old, byhand):
            os.makedirs(d); os.utime(d, (time.time() - 90 * 86400,) * 2)
        open(CURL_LOG, "w").close()
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h, {"WAF_API_BASE": fake.base})
        rep = os.path.join(state, today + "-waf-daily", "waf-inventory", "report.json")
        try: n = len(json.loads(read(rep)))
        except ValueError: n = 0
        check("the job finishes: the inventory in this repository, then the ingest's checks",
              r.returncode == 0 and "WAF refresh finished" in r.stdout and "dry run: nothing written." in r.stdout
              and "validation  passed: 9 zones" in r.stdout, "exit %d: %s" % (r.returncode, (r.stdout + r.stderr).strip()[-200:]))
        check("it ran the inventory in this repository, against the fake API (%d requests)" % len(fake.seen), len(fake.seen) == 30 and all(ok for _, ok in fake.seen))
        check("the report is in today's run folder under ~/.local/state/fleet (9 zones)", n == 9, rep)
        check("the run folder is for its owner only", os.path.isdir(os.path.dirname(os.path.dirname(rep)))
              and stat.S_IMODE(os.stat(os.path.dirname(os.path.dirname(rep))).st_mode) == 0o700)
        check("the job asked whether Cloudflare can be reached, and the stand-in answered", "probe" in read(CURL_LOG).split("\n"))
        check("the token is in nothing the job printed", token not in r.stdout + r.stderr and token not in read(CURL_LOG))
        check("a daily run folder older than a month is removed; one made by hand is kept",
              not os.path.exists(old) and os.path.isdir(byhand))

        # WAF_INVENTORY names another script
        fake.reset(); h2 = daily_home("other")
        other = write(os.path.join(T, "other-inventory.sh"), "#!/bin/bash\n# stands in for someone's own inventory script\n"
                      'mkdir -p "$2" && cp "%s" "$2/report.json" && echo "other inventory ran: $1 $2"\n' % rep, 0o755)
        # the job starts it with python3, so it is written as Python that hands over to that shell script
        other_py = write(os.path.join(T, "other-inventory.py"), 'import subprocess, sys\nsys.exit(subprocess.call(["/bin/bash", %r] + sys.argv[1:]))\n' % other)
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h2, {"WAF_API_BASE": fake.base, "WAF_INVENTORY": other_py})
        check("WAF_INVENTORY names another script, and that one is run instead",
              r.returncode == 0 and "other inventory ran: --out" in r.stdout and not fake.seen, "exit %d, %d requests" % (r.returncode, len(fake.seen)))
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h2, {"WAF_INVENTORY": os.path.join(T, "nothing-here.py")})
        check("control: a script that is not there stops the job", r.returncode == 1 and "inventory script not found" in r.stdout)

        check("control: a job that went through the first time waited for nothing", waits(h) == [] and waits(h2) == [])

        # no token: the inventory fails both times
        fake.reset(); h3 = daily_home("notoken", with_token=False)
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h3, {"WAF_API_BASE": fake.base})
        check("with no token set up the job stops, says what to set, and sends nothing",
              r.returncode == 1 and "STOPPED: the inventory script failed twice" in r.stdout and "nothing written to the database." in r.stdout
              and "FLEET_CF_TOKEN_ALL_READ" in r.stderr and not fake.seen, "exit %d" % r.returncode)

        # a read that fails once: the inventory is taken again a minute later
        fake.reset(); h4 = daily_home("refused-once")
        fake.first = {"http_ratelimit/entrypoint": [refusal]}
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h4, {"WAF_API_BASE": fake.base})
        try: n = len(json.loads(read(report_in(h4))))
        except ValueError: n = 0
        check("a read Cloudflare refuses once does not stop the job: the inventory is taken once more, and that one is loaded",
              r.returncode == 0 and "WAF refresh finished" in r.stdout and "validation  passed: 9 zones" in r.stdout and n == 9
              and "could not read the rate-limit rules" in r.stderr and lists() == 2, "exit %d, %d inventories: %s" % (r.returncode, lists(), r.stdout.strip()[-160:]))
        check("  ...after one wait of 60 seconds, which it announces", waits(h4) == ["60"]
              and "the inventory script failed; taking the inventory once more in 60 seconds" in r.stdout and "STOPPED" not in r.stdout, str(waits(h4)))

        # the same read fails twice: only now does the job stop
        fake.reset(); h5 = daily_home("refused-twice")
        fake.first = {"http_ratelimit/entrypoint": [refusal, refusal, refusal]}
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h5, {"WAF_API_BASE": fake.base})
        check("a read Cloudflare refuses twice stops the job with no report for the ingest to load",
              r.returncode == 1 and "STOPPED: the inventory script failed twice" in r.stdout and "nothing written to the database." in r.stdout
              and not os.path.exists(report_in(h5)) and "validation" not in r.stdout, "exit %d: %s" % (r.returncode, r.stdout.strip()[-160:]))
        check("  ...after two inventories and one wait, not more", lists() == 2 and waits(h5) == ["60"] and len(fake.first["http_ratelimit/entrypoint"]) == 1,
              "%d inventories, waits %s" % (lists(), waits(h5)))

        # the wait can be shortened for a test, and only to a number
        fake.reset(); h6 = daily_home("short-wait")
        fake.first = {"http_ratelimit/entrypoint": [refusal]}
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h6, {"WAF_API_BASE": fake.base, "WAF_REFRESH_RETRY_SECONDS": "2"})
        check("WAF_REFRESH_RETRY_SECONDS shortens the wait", r.returncode == 0 and waits(h6) == ["2"] and "once more in 2 seconds" in r.stdout, str(waits(h6)))
        fake.reset()
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h6, {"WAF_API_BASE": fake.base, "WAF_REFRESH_RETRY_SECONDS": "soon"})
        check("  ...and a wait that is not a number stops the job before the inventory", r.returncode == 1 and not fake.seen
              and "WAF_REFRESH_RETRY_SECONDS must be a whole number of seconds" in r.stdout)

        # a report the ingest refuses: the same second chance, as before
        good = read(rep)
        def inventory_that_writes(tag, reports):
            """Stands in for an inventory script: writes the next of these reports each time it is run."""
            for i, text in enumerate(reports):
                write(os.path.join(T, "seq-%s" % tag, "%d.json" % (i + 1)), text)
            return write(os.path.join(T, "seq-%s.py" % tag),
                         'import os, shutil, sys\nd = %r\nn = len(os.listdir(d)) - %d + 1\nopen(os.path.join(d, "ran-%%d" %% n), "w").close()\n'
                         'os.makedirs(sys.argv[2], exist_ok=True)\nshutil.copy(os.path.join(d, "%%d.json" %% n), os.path.join(sys.argv[2], "report.json"))\n'
                         % (os.path.join(T, "seq-%s" % tag), len(reports)))
        unmasked = good.replace("<43-char value redacted>", PLANTED)
        fake.reset(); h7 = daily_home("ingest-once")
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h7, {"WAF_INVENTORY": inventory_that_writes("once", [unmasked, good])})
        check("control: the made-up reports differ, and the first holds a value the ingest must refuse", unmasked != good and PLANTED in unmasked)
        check("a report the ingest refuses once is taken again after the wait, and the second one is accepted",
              r.returncode == 0 and "NOT INGESTED" in r.stderr and "the ingest refused this run; taking the inventory once more in 60 seconds" in r.stdout
              and "WAF refresh finished" in r.stdout and waits(h7) == ["60"] and read(report_in(h7)) == good, "exit %d, waits %s" % (r.returncode, waits(h7)))
        fake.reset(); h8 = daily_home("ingest-twice")
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h8, {"WAF_INVENTORY": inventory_that_writes("twice", [unmasked, unmasked, good])})
        check("a report the ingest refuses twice stops the job, and the run folder is kept and named",
              r.returncode == 1 and "STOPPED: the ingest refused this run twice (reason above). Run folder kept: %s" % os.path.dirname(os.path.dirname(report_in(h8))) in r.stdout
              and waits(h8) == ["60"] and r.stderr.count("NOT INGESTED") == 2 and "WAF refresh finished" not in r.stdout, "exit %d, waits %s" % (r.returncode, waits(h8)))
        h9 = daily_home("no-report")
        nothing = write(os.path.join(T, "writes-nothing.py"), "import sys\nsys.exit(0)\n")
        r = run([REAL["bash"], "scripts/waf-refresh.sh", "--dry-run"], h9, {"WAF_INVENTORY": nothing})
        check("an inventory that says it worked and wrote no report stops the job at once: that is not a blip",
              r.returncode == 1 and "STOPPED: the inventory wrote no report.json" in r.stdout and waits(h9) == [])
    finally:
        fake.stop()


# ==============================================================================
# E. The token on its way to a server
# ==============================================================================
def part_e():
    global PART
    PART = "E"; say("E. the token on its way to a server: in the text sent down ssh's standard input, nowhere else")
    fx = fixtures(); zid = "ab" * 16
    def captured(cap):
        calls = int(read(os.path.join(cap, "count")).strip() or 0)
        return calls, [read(os.path.join(cap, "call-%d.args" % i)) for i in range(1, calls + 1)], \
               [read(os.path.join(cap, "call-%d.stdin" % i)) for i in range(1, calls + 1)]
    def start(tag):
        h = home("e-" + tag); cap = os.path.join(T, "cap-e-" + tag); os.makedirs(cap)
        audit_and_report(os.path.join(h, ".local", "state", "fleet"), zid)
        return h, cap, dict(fx, CAP=cap, FAKE_SSH_REPLY=os.path.join(T, "fx", "reply-dry"))

    tok = "made-up-server-token-web1-0004"
    h, cap, env = start("live")
    write(os.path.join(h, ".config", "fleet", "tokens", "cloudflare-f2b-web1.token"), tok + "\n", 0o600)
    r = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1", "--live"], h, env)
    calls, args, stdin = captured(cap)
    check("a live apply sends twice: the dry run, then the real one", calls == 2, "%d sends: %s" % (calls, (r.stdout + r.stderr).strip()[-120:]))
    check("the token is on its own line in the text of the second send, as CF_TOKEN='...'",
          calls == 2 and stdin[1].split("\n")[1] == "CF_TOKEN='%s'" % tok and tok not in stdin[0])
    check("the token is in none of ssh's arguments, and in nothing the script printed",
          calls == 2 and not any(tok in a for a in args) and tok not in r.stdout + r.stderr)
    check("the dry run alone never asks for the token", "ABORT" not in run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1"], home("e-dry0"),
          dict(start("dry")[2])).stderr)

    h, cap, env = start("notoken")
    r = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "web1", "--live"], h, env)
    calls, args, stdin = captured(cap)
    check("with no token for that server, live stops after the dry run and says what to set",
          r.returncode == 1 and calls == 1 and "FLEET_CF_TOKEN_F2B_WEB1" in r.stderr and "tokens/cloudflare-f2b-web1.token" in r.stderr,
          "exit %d, %d sends" % (r.returncode, calls))

    tok2 = "made-up-server-token-web2-0005"
    h, cap, env = start("label")
    write(os.path.join(h, ".config", "fleet", "tokens", "cloudflare-f2b-web-2.token"), tok2 + "\n", 0o600)
    write(os.path.join(h, ".config", "fleet", "tokens", "cloudflare-f2b-web1.token"), tok + "\n", 0o600)
    r = run([REAL["bash"], "scripts/fleet-fail2ban-apply.sh", "Web_2", "--live"], h, env)
    calls, args, stdin = captured(cap)
    check("a label with capitals and _ asks for the token in lower case with - (and gets that server's, not another's)",
          calls == 2 and "CF_TOKEN='%s'" % tok2 in stdin[1] and tok not in stdin[1], "%d sends" % calls)

    h, cap, env = start("proof")
    r = run([REAL["bash"], "scripts/fleet-fail2ban-token-proof.sh", "web1", "example.com", zid], h, dict(env, FLEET_CF_TOKEN_F2B_WEB1=tok))
    calls, args, stdin = captured(cap)
    check("the token proof sends the token the same way: first line of the text, not an argument, not printed",
          calls == 1 and stdin[0].split("\n")[0] == "CF_TOKEN='%s'" % tok and tok not in args[0] and tok not in r.stdout + r.stderr,
          "%d sends" % calls)
    h, cap, env = start("proof-none")
    r = run([REAL["bash"], "scripts/fleet-fail2ban-token-proof.sh", "web1", "example.com", zid], h, env)
    calls, _, _ = captured(cap)
    check("with no token, the token proof stops before it connects to anything", r.returncode == 1 and calls == 0 and "FLEET_CF_TOKEN_F2B_WEB1" in r.stderr)


for name, fn in (("A", part_a), ("B", part_b), ("C", part_c), ("D", part_d), ("E", part_e)):
    if name in PARTS:
        fn()

print()
if failed:
    print("%d checks, %d FAILED" % (ran, failed)); sys.exit(1)
print("%d checks, 0 failed" % ran)
