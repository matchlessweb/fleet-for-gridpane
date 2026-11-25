#!/bin/bash
# ==============================================================================
# The names the fleet scripts install under: read from one file, never guessed,
# and, where a baseline commit is set, unchanged from what that commit installed
# ==============================================================================
#   bash scripts/test-fleet-names.sh                 the whole proof   (npm run names:test)
#   bash scripts/test-fleet-names.sh --no-baseline   parts A, B and D only (see part C)
#   bash scripts/test-fleet-names.sh --require-baseline   fail if part C cannot run
#   bash scripts/test-fleet-names.sh --controls      break the scripts on purpose, one way at a
#                                                    time, and check this test notices each one
#
# NOTHING HERE REACHES A SERVER. The scripts under test are copied to a temp
# folder and run there with a stand-in `ssh` first on the PATH: it writes down
# what it was handed and answers "ok". The server list is two made-up servers at
# documentation addresses, HOME is a temp folder, and curl, a token helper,
# security, scp and rsync are stand-ins too. A script that needs a Cloudflare
# token is given one by a made-up token command (lib-fleet-token.sh), which here
# is the same stand-in an older baseline may call by name, so both receive one value.
#
# A. The shell reader (lib-fleet-names.sh) reads what the app reads from
#    fleet.config.ts, and from the example config.
# B. The reader stops instead of using a default: no file, a key there twice, a
#    bad character, an empty value, a value too long, a bad value in the
#    environment. A program sent to a server unfilled refuses to run.
# C. BEFORE AND AFTER. Every script is run as it was at the baseline commit and
#    as it is now, and what each would send to a server is compared: the ssh
#    arguments byte for byte (they carry the files that get installed, base64),
#    and the program text as bash itself parses it, so comments do not count
#    but every command, string and here-document does. Three things left the
#    scripts for settings after the baseline and are held to one fixed shape
#    each: the operator's SSH key, the folder runs are kept in, and where a
#    Cloudflare token comes from. The daily WAF job's inventory script moved
#    into this repository; that one line is allowed and checked. The same job
#    now takes the inventory a second time when the first one fails (the
#    baseline did that only after a refused ingest): its loop is held to one
#    fixed shape and read as the baseline's. The one line each new
#    program adds, its own "was I filled in?" check, is held to one fixed shape
#    and then set aside. Three later changes are held the same way and read as
#    the baseline's: the host-key options every script takes from
#    lib-fleet-hostkeys.sh (the baseline checked no host key), the service key
#    the token script sends to curl on standard input, and --apply on the
#    allow-list installer (the baseline applied on an address alone). Their own
#    tests are test-fleet-hostkeys.sh, test-curl-secrets.sh and
#    test-installers-apply.sh. Five more are held the same way, each to its exact
#    text: the site copy's load, which takes DEFINER out first and stops on a
#    failed load (lib-sql-definer.sh; fleet-site-move-selftest.sh); the token
#    script's check of all six reporters, where the baseline checked three; its
#    closing line, which no longer names a step the database already holds; the
#    agent update's "was there an old copy?" line; and the 7G log-rotation
#    program's match, which names only per-site /var/www/.../7g.log rules (a bare
#    "7g.log" also matched GridPane's own nginx rule).
#    Needs a baseline commit: FLEET_NAMES_BASELINE,
#    else the one line in ~/.config/fleet/names-baseline, and that commit in this
#    repository's history. It is only for an install whose scripts spelled the
#    names out before they became settings. Without one, this part is reported
#    NOT RUN, in capitals, and the last line says the proof is not whole.
#    --require-baseline makes that a failure instead.
# D. With other names (prefix "fleet", name "Fleet", jail prefix "fleet", and a
#    second made-up set), nothing a script would send, install or print still
#    carries this install's own words, and the installed names follow the
#    setting.
#
# The baseline's own names are never written in this file: they are read out of
# the baseline scripts when the test runs.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TREE="${FLEET_NAMES_TREE:-$REPO}"                 # the scripts under test (a broken copy, in --controls)
# The last commit before the names became settings, for an install that has one (part C).
BASELINE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/fleet/names-baseline"
BASELINE="${FLEET_NAMES_BASELINE:-}"
[ -n "$BASELINE" ] || BASELINE=$(head -n 1 "$BASELINE_FILE" 2>/dev/null | tr -d '[:space:]')
WANT_BASELINE=1; REQUIRE_BASELINE=0; CONTROLS=0; QUIET=0
for a in "$@"; do
    case "$a" in
        --controls) CONTROLS=1 ;; --no-baseline) WANT_BASELINE=0 ;; --require-baseline) REQUIRE_BASELINE=1 ;; --quiet) QUIET=1 ;;
        -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $a (only --no-baseline, --require-baseline, --controls)"; exit 2 ;;
    esac
done
command -v python3 >/dev/null || { echo "ABORT: python3 is needed"; exit 1; }
command -v node >/dev/null || { echo "ABORT: node is needed (part A reads fleet.config.ts the way the app does)"; exit 1; }
[ -r "$TREE/fleet.config.ts" ] || { echo "ABORT: $TREE/fleet.config.ts is not there. Copy fleet.config.example.ts to it first."; exit 1; }

T=$(mktemp -d) || exit 1
if [ -n "${FLEET_NAMES_KEEP:-}" ]; then echo "keeping $T"; else trap 'rm -rf "${T:?}"' EXIT; fi
fail=0; ran=0; notrun=0; PART=""
ok()   { ran=$((ran+1)); [ "$QUIET" = 1 ] || echo "  ok   $PART  $1"; }
bad()  { ran=$((ran+1)); fail=$((fail+1)); echo "  FAIL $PART  $1${2:+  ($2)}"; }
skip() { notrun=$((notrun+1)); echo "  NOT RUN $PART  $1"; }
yes()  { if [ "$2" = 1 ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }       # label, 1|0, detail
same() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got \"$2\", wanted \"$3\""; fi; }
say()  { [ "$QUIET" = 1 ] || echo "$@"; }
count() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
bytes() { find "$1" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' '; }

# ------------------------------------------------------------------------------
# The stand-ins and the fixtures
# ------------------------------------------------------------------------------
mkdir -p "$T/bin" "$T/nobin" "$T/home" "$T/tmp" "$T/fx/audit"
cat > "$T/bin/ssh" <<'EOF'
#!/bin/bash
# Stand-in for ssh: writes down what it was given and reaches nothing.
n=$(( $(cat "$CAP/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CAP/count"
printf '%s\n' "$@" > "$CAP/call-$n.args"
cat > "$CAP/call-$n.stdin"
if [ -r "${FAKE_SSH_REPLY:-}" ]; then cat "$FAKE_SSH_REPLY"; else echo "ok"; fi
EOF
for c in scp rsync security supabase ssh-add sleep; do printf '#!/bin/bash\nexit 0\n' > "$T/bin/$c"; done
# Stand-in for a token helper: writes down what it was asked for and prints one made-up value.
printf '#!/bin/bash\n[ -z "${CAP:-}" ] || printf "%%s\\n" "$*" >> "$CAP/secret.log"\necho "stand-in-secret-value"\n' > "$T/bin/secret"
# A baseline from before the token-command setting may call this helper by name. The scripts under
# test ask the token command named in the settings, so the made-up home folder names the same one.
mkdir -p "$T/home/.config/fleet"
printf 'secret cloudflare-{name}.token\n' > "$T/home/.config/fleet/cloudflare-token-command"; chmod 600 "$T/home/.config/fleet/cloudflare-token-command"
# The sign-in installer reads its server list from the database: answer with the same two.
printf '#!/bin/bash\ncat > /dev/null\nprintf %s\n' "'[{\"id\":101,\"ip\":\"203.0.113.21\",\"label\":\"web1\"},{\"id\":102,\"ip\":\"203.0.113.22\",\"label\":\"web2\"}]\n200'" > "$T/bin/curl"
chmod +x "$T/bin"/*
printf '203.0.113.21|101|web1|golden\n203.0.113.22|102|web2\n' > "$T/fx/servers"
ZONE="0a1b2c0a1b2c0a1b2c0a1b2c0a1b2c0a"
printf '{"example.com":{"zone_id":"%s","reach":{"reach":"direct"}}}\n' "$ZONE" > "$T/fx/report.json"
printf 'dry_run_complete=yes\nconfig_test=ok\nhelper_syntax=ok\nhelper_needs python3=yes 3\ncontrol=ok\nsample a ok\nsample b ok\nsample c ok\n' > "$T/fx/reply-dry"
printf 'NEXT_PUBLIC_SUPABASE_URL=https://db.example.com\nNEXT_PUBLIC_SUPABASE_ANON_KEY=stand-in-public-key-000000000000\nSUPABASE_SERVICE_ROLE_KEY=stand-in-service-key-00000000000\n' > "$T/fx/env"
RUNPATH="$T/bin:$(dirname "$(command -v python3)"):/usr/bin:/bin:/usr/sbin:/sbin"

# The scripts under test, copied so nothing they write lands in the repository.
# The real server list, if this checkout has one, is left behind.
NEW="$T/new"; mkdir -p "$NEW"
cp -R "$TREE/scripts" "$NEW/scripts" && cp "$TREE/fleet.config.ts" "$NEW/"
[ -r "$TREE/fleet.config.example.ts" ] && cp "$TREE/fleet.config.example.ts" "$NEW/"
rm -f "$NEW/scripts/servers.local"
LIB="$NEW/scripts/lib-fleet-names.sh"

# reader <VAR=value>... -- <bash text>: source the reader in an empty environment and run the text.
reader() {
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    env -i PATH="$RUNPATH" HOME="$T/home" FLEET_NAMES_TEST=1 ${envs[@]+"${envs[@]}"} bash -c '. "$1" || exit 9; '"$1" reader "$LIB"
}
ALL='printf "%s\n" "$FLEET_PREFIX" "$FLEET_JAIL_PREFIX" "$FLEET_NAME" "$(fleet_repo_url)" "$(fleet_waf_refresh_label)"'

# canon <file>: the program as bash parses it. Comments are gone; every command, string and
# here-document is kept. Nothing in the file is run: it is wrapped in a function that is never
# called, and only after `bash -n` says it is a whole program (so the wrapper cannot close early).
canon() {
    if ! grep -q '[^[:space:]]' "$1"; then return 0; fi
    bash -n "$1" 2>/dev/null || { echo "NOT-A-PROGRAM"; return 1; }
    { printf '__canon__ () {\n'; cat "$1"; printf '\n}\n'; } > "$T/canon.in"
    env -i PATH="$T/nobin" /bin/bash -c '. "$1" && declare -f __canon__' canon "$T/canon.in"
}
# The one line a new server program adds. Held to this exact shape, so the tag cannot hide anything else.
GUARD_SHAPE='^case '"'"'[^'"'"']*'"'"' in (\([^)]*\) ((say|echo|stop) "[^"$`\\]*"|exit 1)?(; ((say|echo|stop) "[^"$`\\]*"|exit 1))* ?;; )+esac   # names-guard$'
strip_guard() { grep -v '# names-guard$' "$1"; }
guards_ok() { [ "$(grep -c '# names-guard' "$1")" = "$(grep -cE "$GUARD_SHAPE" "$1")" ]; }

# sender <tree> <capture dir> <case> <reply file or -> <script> [args]: run one script, keep what it sent.
SET_ENV=("FLEET_NAMES_TEST=1")
sender() {
    local tree="$1" cap="$2/$3" reply="$4" script="$5"; shift 5
    mkdir -p "$cap"
    ( cd "$tree" && env -i PATH="$RUNPATH" HOME="$T/home" TMPDIR="$T/tmp" CAP="$cap" FLEET_SERVERS_FILE="$T/fx/servers" \
        F2B_AUDIT_OUT="$T/fx/audit" WAF_REPORT="$T/fx/report.json" FLEET_ENV_FILE="$T/fx/env" FAKE_SSH_REPLY="$reply" \
        "${SET_ENV[@]}" bash "scripts/$script" "$@" </dev/null >"$cap/stdout" 2>&1 )
    echo $? > "$cap/rc"
}
# Unpack every base64 argument a capture carries: those are the files that get installed.
unpack() {
    local f n i tok
    for f in "$1"/*/call-*.args; do
        [ -r "$f" ] || continue; i=0
        for tok in $(grep -oE '[A-Za-z0-9+/]{80,}={0,2}' "$f"); do
            i=$((i+1)); printf '%s' "$tok" | base64 --decode > "${f%.args}.file-$i" 2>/dev/null || rm -f "${f%.args}.file-$i"
        done
    done
}
biggest() { ls -S "$1"/*.file-* 2>/dev/null | head -1; }
# Every script, every mode that sends something. <tree> <capture dir> <golden agent or self> <golden rule or self>
run_cases() {
    local tr="$1" cd="$2" ga="$3" gr="$4" m
    # The audit writes its answer where the setup script reads one, so the setup runs first, on a fresh fixture.
    printf 'site=shop.example.com wp=yes\naudit_complete=yes\n' > "$T/fx/audit/web1.txt"
    sender "$tr" "$cd" f2b-dry-run    -  fleet-fail2ban-apply.sh web1
    sender "$tr" "$cd" f2b-live       "$T/fx/reply-dry" fleet-fail2ban-apply.sh web1 --live --enable-plugin
    sender "$tr" "$cd" f2b-proof      -  fleet-fail2ban-token-proof.sh web1 example.com "$ZONE"
    sender "$tr" "$cd" f2b-audit      -  fleet-fail2ban.sh web1
    sender "$tr" "$cd" snapshot       -  fleet-server-snapshot.sh web1
    sender "$tr" "$cd" hold-status    -  fleet-site-hold.sh shop.example.com web1 status
    for m in hold-jobs release-jobs freeze unfreeze; do sender "$tr" "$cd" "hold-$m" - fleet-site-hold.sh shop.example.com web1 "$m" --live; done
    sender "$tr" "$cd" final-copy     -  fleet-site-final-copy.sh shop.example.com --from web1 --to web2 --files-since "2026-01-15 06:20:00" rehearse
    sender "$tr" "$cd" agent-audit    -  fix-telemetry-crontabs.sh
    sender "$tr" "$cd" agent-fix      -  fix-telemetry-crontabs.sh --fix
    sender "$tr" "$cd" agent-update   -  fix-telemetry-crontabs.sh --update
    unpack "$cd"; [ "$ga" != self ] || ga="$(biggest "$cd/agent-update")"
    sender "$tr" "$cd" agent-install  "$ga" fix-telemetry-crontabs.sh --install
    sender "$tr" "$cd" rotate-audit   -  install-7g-logrotate.sh
    sender "$tr" "$cd" rotate-set     -  install-7g-logrotate.sh --set
    sender "$tr" "$cd" rotate-reclaim -  install-7g-logrotate.sh --reclaim
    unpack "$cd"; [ "$gr" != self ] || gr="$(biggest "$cd/rotate-set")"
    sender "$tr" "$cd" rotate-clone   "$gr" install-7g-logrotate.sh --clone
    sender "$tr" "$cd" certbot-audit  -  install-certbot-port-hook.sh
    for m in apply prove remove; do sender "$tr" "$cd" "certbot-$m" - install-certbot-port-hook.sh "--$m" web1; done
    sender "$tr" "$cd" signin-audit   -  install-fleet-sso-agent.sh
    sender "$tr" "$cd" signin-remove  -  install-fleet-sso-agent.sh --remove web1
    sender "$tr" "$cd" allow-audit    -  install-operator-allowlist.sh
    # The allow-list installer changes a server only with --apply now. The baseline took an address alone, --clear
    # and the two web-port options as the instruction itself, so each tree is asked in its own way and what they send is compared.
    local apply="--apply"; [ "$tr" != "${OLD:-}" ] || apply=""
    sender "$tr" "$cd" allow-apply    -  install-operator-allowlist.sh $apply 203.0.113.50 web1
    sender "$tr" "$cd" allow-clear    -  install-operator-allowlist.sh $apply --clear
    sender "$tr" "$cd" allow-web      -  install-operator-allowlist.sh $apply --ufw-web 203.0.113.50 web2
    sender "$tr" "$cd" allow-web-off  -  install-operator-allowlist.sh $apply --ufw-web-clear 203.0.113.50 web2
    unpack "$cd"
}
calls() { cat "$1"/*/count 2>/dev/null | awk '{s+=$1} END {print s+0}'; }
# generate <program> <out dir>: let the Fail2Ban program write its files into a temp root, as its self-test does.
generate() {
    mkdir -p "$2/etc/fail2ban/action.d" "$2/etc/fail2ban/jail.d" "$2/etc/fail2ban/filter.d"
    env -i PATH="$RUNPATH" HOME="$T/home" F2B_ROOT="$2" bash "$1" generate "shop.example.com|$ZONE|example.com" "other.example|$ZONE|other.example" > "$2.out" 2>&1
}

# ==============================================================================
# --controls: break a copy of the scripts one way at a time; each must be noticed
# ==============================================================================
if [ "$CONTROLS" = 1 ]; then
    [ -n "$BASELINE" ] && git -C "$REPO" cat-file -e "$BASELINE^{commit}" 2>/dev/null || { echo "ABORT: the controls need a baseline commit in this history (FLEET_NAMES_BASELINE or ~/.config/fleet/names-baseline): ${BASELINE:-none is set}."; exit 1; }
    OJ=$(git -C "$REPO" show "$BASELINE:scripts/fleet-fail2ban-apply.remote.sh" | sed -n "s/.*printf '\([a-z0-9]*\)-%s-%s'.*/\1/p" | head -1)
    OBK=$(git -C "$REPO" show "$BASELINE:scripts/waf-refresh.sh" | sed -n 's/^BACKUPS="\(.*\)"$/\1/p')
    n=0; caught=0
    try() { # label, part that must fail, file, perl expression
        local copy="$T/broken-$n" out rc; n=$((n+1)); copy="$T/broken-$n"
        mkdir -p "$copy"; cp -R "$TREE/scripts" "$copy/scripts"; cp "$TREE"/fleet.config*.ts "$copy/"
        OJ="$OJ" OBK="$OBK" perl -0pi -e "$4" "$copy/scripts/$3"
        if cmp -s "$copy/scripts/$3" "$TREE/scripts/$3"; then echo "  MISSED  $1  (the break did not change $3: fix this control)"; rm -rf "$copy"; return; fi
        out=$(FLEET_NAMES_TREE="$copy" FLEET_NAMES_BASELINE="$BASELINE" bash "$0" --quiet 2>&1); rc=$?
        if [ "$rc" != 0 ] && printf '%s\n' "$out" | grep -q "^  FAIL $2"; then caught=$((caught+1)); echo "  caught  $1  ($(printf '%s\n' "$out" | grep -c '^  FAIL') failing, part $2 among them)"
        else echo "  MISSED  $1  (exit $rc, wanted a failure in part $2)"; printf '%s\n' "$out" | tail -4 | sed 's/^/          /'; fi
        rm -rf "$copy"
    }
    echo "Breaking a copy of the scripts on purpose. Each line is one full run of this test."
    try "the reader takes the jail prefix from the wrong key"         A lib-fleet-names.sh 's/fleet_config_value jailPrefix/fleet_config_value prefix/'
    try "the reader falls back to a built-in prefix"                  B lib-fleet-names.sh 's/v=\$\(fleet_config_value prefix\) \|\| return 1/v=\$(fleet_config_value prefix 2>\/dev\/null) || v=fleet/'
    try "the reader accepts a prefix with a capital and a hyphen"     B lib-fleet-names.sh 's/\^\[a-z\]\[a-z0-9\]\{1,14\}\$/^[A-Za-z][A-Za-z0-9-]{1,14}\$/'
    try "a server program loses its filled-in check"                  B fleet-site-hold.remote.sh 's/^case .__FLEET_PREFIX__. in .*names-guard\n//m'
    try "a server program installs its action under another name"     C fleet-fail2ban-apply.remote.sh 's/action\.d\/__FLEET_PREFIX__-cloudflare\.conf/action.d\/__FLEET_PREFIX__-cf.conf/g'
    try "one line inside a file a server program writes is changed"   C fleet-fail2ban-apply.remote.sh 's/^before = wordpress/before  = wordpress/m; s/^\[INCLUDES\]$/[INCLUDES] /m; s/failregex = /failregex  = /'
    try "one comment in the telemetry agent is reworded"              C telemetry-agent.sh 's/^# (.*)a(.*)$/# $1A$2/m'
    try "the logrotate installer forgets to fill in its rule"         C install-7g-logrotate.sh 's/^fleet_names_fill_var STANDARD_RULE.*\n//m'
    try "the certbot hook is installed under another name"            C install-certbot-port-hook.sh 's/__FLEET_PREFIX__-port-window/__FLEET_PREFIX__-window/g'
    try "the WAF refresh job logs to another file"                    C install-waf-refresh.sh 's/\$FLEET_PREFIX-fleet-waf-refresh\.log/\$FLEET_PREFIX-waf-refresh.log/'
    try "a hidden command rides on a tagged filled-in check"          C fleet-server-snapshot.remote.sh 's/^(case .__FLEET_PREFIX__. in .*) ;; esac   # names-guard$/$1 ;; esac; touch \/tmp\/x   # names-guard/m'
    try "a jail name is spelled out instead of following the setting" D fleet-fail2ban-apply.remote.sh 's/__FLEET_JAIL_PREFIX__-base-hard/$ENV{OJ}-base-hard/g'
    try "the agent looks for the action under a spelled-out name"     D telemetry-agent.sh 's/\/jail\.d\/__FLEET_PREFIX__-cloudflare\.local/\/jail.d\/__FLEET_PREFIX__-cloudflare.local" if 0 else "\/x\/__FLEET_PREFIX__-x/; s/__FLEET_JAIL_PREFIX__-f2b-report/$ENV{OJ}-f2b-report/'
    try "one script reads the operator's key another way"              C fleet-site-hold.sh 's/^KEY_FP="\$\{FLEET_SSH_KEY_FP:-/KEY_FP="\${FLEET_KEY:-/m'
    try "a script carries a key fingerprint of its own again"         C install-7g-logrotate.sh 's/^(KEY_FP=.*)$/$1 . "\n# was SHA256:" . ("Ab1+" x 10) . "xyz"/me'
    try "a script with no fingerprint set accepts no key at all"      C fleet-fail2ban.sh 's/KEY_FP="\$\{KEY_FP:-SHA256:\}"/KEY_FP="\${KEY_FP:-none}"/'
    try "one script reads the folder it keeps runs in another way"    C fleet-server-snapshot.sh 's/FLEET_OUT="\$\(fleet_output_dir\)"/FLEET_OUT="\${FLEET_OUTPUT_DIR:-\$HOME\/.local\/state\/fleet}"/'
    try "one script reads the folder setting itself, beside the function" C fleet-fail2ban-apply.sh 's/^(AUDIT_DIR=.*)$/[ -r "\$HOME\/.config\/fleet\/output-dir" ] && FLEET_OUT="\$(cat "\$HOME\/.config\/fleet\/output-dir")"\n$1/m'
    try "the shared function reads the folder from another variable"  C lib-fleet-output.sh 's/local dir="\$\{FLEET_OUTPUT_DIR:-\}"/local dir="\${FLEET_DIR:-}"/'
    try "the shared function has another default folder"              C lib-fleet-output.sh 's/\$HOME\/\.local\/state\}\/fleet/\$HOME\/.local\/share}\/fleet/'
    try "a script keeps its runs in a folder of its own again"        C fleet-fail2ban.sh 's/\$FLEET_OUT\/\$\(date/\$HOME\/fleet-runs\/\$(date/'
    try "a script spells out the baseline's folder again"             C fleet-server-restore.sh 's/"\$FLEET_OUT"\/\*-server-snapshots/"$ENV{OBK}"\/*-server-snapshots/'
    try "the daily job's inventory script is outside the repository"  C waf-refresh.sh 's/\$REPO\/scripts\/waf-inventory\.py\}/\$HOME\/waf-inventory.py}/'
    try "the daily job gains a command the baseline did not have"     C waf-refresh.sh 's/^(GENERATOR=.*)$/$1\nGENERATOR_ARGS="--all"/m'
    try "the daily job stops at the first failed inventory, as it did" C waf-refresh.sh 's/^  if ! python3 "\$GENERATOR" --out "\$OUT"; then\n    why="the inventory script failed"\n  elif \[ ! -s "\$OUT\/report\.json" \]; then\n    stop "the inventory wrote no report\.json"\n  elif (node [^\n]*); then\n    break\n  else\n    why="the ingest refused this run"\n  fi\n/  python3 "\$GENERATOR" --out "\$OUT" || stop "the inventory script failed"\n  [ -s "\$OUT\/report.json" ] || stop "the inventory wrote no report.json"\n  $1 && break\n  why="the ingest refused this run"\n/m'
    try "the daily job's second try gains a command"                  C waf-refresh.sh 's/^(  sleep "\$PAUSE")$/$1\n  rm -rf "\$OUT"/m'
    try "a live apply asks for its token under another name"          C fleet-fail2ban-apply.sh 's/fleet_cf_token "f2b-/fleet_cf_token "f2b./'
    try "the token proof hands the token to ssh as an argument"       C fleet-fail2ban-token-proof.sh 's/^(\$BODY" "\$ZONE" "\$ZID")$/$1 "\$SERVER_TOKEN"/m'
    try "one script accepts any host key again, as the baseline did"  C fleet-fail2ban.sh 's/^SSH_OPTS="\$FLEET_HOSTKEY_OPTS /SSH_OPTS="-o StrictHostKeyChecking=no /m'
    try "the host-key options gain a third option"                    C lib-fleet-hostkeys.sh 's/(-o UserKnownHostsFile=\$f)"/$1 -o LogLevel=QUIET"/'
    try "the host keys are kept in another file"                      C lib-fleet-hostkeys.sh 's/\/fleet\/known_hosts\}"/\/fleet\/hosts}"/'
    try "the runner gains a line under the host-keys tag"             C lib-fleet-ssh.sh 's/^(    fleet_hostkey_refusal "\$errf" "\$ip" \|\| true   # host-keys)$/$1\n    FLEET_SSH_OUT=""   # host-keys/m'
    try "the site copy carries on after a refused host key"           C fleet-site-final-copy.sh 's/if fleet_hostkey_refusal "\$SSHERR" "\$2"; then exit 1; fi/if fleet_hostkey_refusal "\$SSHERR" "\$2"; then exit 0; fi/'
    try "the token script sends a third header on standard input"     C provision-agent-tokens.sh 's/(Authorization: Bearer %s\\n)\x27 "\$SK" "\$SK"/$1X-More: 1\\n\x27 "\$SK" "\$SK"/'
    try "the allow-list apply sends an address it was not given"      C install-operator-allowlist.sh 's/("\$REMOTE_ALLOWLIST" "\$MODE" "\$CONFIG_PATH") "\$IPS"/$1 "\$IPS 192.0.2.9"/'
    echo; echo "$n broken copies: $caught caught, $((n - caught)) missed"
    [ "$caught" = "$n" ]; exit $?
fi

# ==============================================================================
# A. The shell reader and the app read the same names
# ==============================================================================
PART=A; say "A. the shell reader reads what the app reads"
cat > "$T/config.mjs" <<'EOF'
const { fleetConfig: c } = await import(process.argv[2]);
console.log([c.server.prefix, c.server.jailPrefix, c.name, c.repoUrl, c.wafRefreshLabel].join("\n"));
EOF
app_reads() { node --experimental-strip-types --no-warnings "$T/config.mjs" "file://$1" 2>/dev/null; }
APP="$(app_reads "$NEW/fleet.config.ts")"; SH="$(reader -- "$ALL" 2>&1)"
yes "the app's config has all five values" "$([ "$(printf '%s\n' "$APP" | grep -c .)" = 5 ] && echo 1 || echo 0)"
same "fleet.config.ts: prefix, jail prefix, name, code address and job label all agree" "$SH" "$APP"
P="$(printf '%s\n' "$APP" | sed -n 1p)"; J="$(printf '%s\n' "$APP" | sed -n 2p)"; N="$(printf '%s\n' "$APP" | sed -n 3p)"
if [ -r "$NEW/fleet.config.example.ts" ]; then
    same "fleet.config.example.ts: the same five agree" "$(reader "FLEET_CONFIG_FILE=$NEW/fleet.config.example.ts" -- "$ALL" 2>&1)" "$(app_reads "$NEW/fleet.config.example.ts")"
else skip "the example config is not in this tree"; fi
same "a value set in the environment wins over the file" "$(reader FLEET_PREFIX=zz9 FLEET_JAIL_PREFIX=q7 "FLEET_NAME=Other Name" -- 'echo "$FLEET_PREFIX $FLEET_JAIL_PREFIX $FLEET_NAME"' 2>&1)" "zz9 q7 Other Name"
same "the worked-out values follow the prefixes" "$(reader FLEET_PREFIX=acme FLEET_JAIL_PREFIX=abcdefgh FLEET_NAME=X -- 'echo "$FLEET_BRAND $FLEET_JAIL_UPPER $FLEET_JAIL_SITE_CHARS"' 2>&1)" "Acme ABCDEFGH 8"
same "a short jail prefix leaves a site 12 characters, as before" "$(reader FLEET_PREFIX=acme FLEET_JAIL_PREFIX=zq FLEET_NAME=X -- 'echo "$FLEET_JAIL_SITE_CHARS"' 2>&1)" "12"

# ==============================================================================
# B. It stops; it never uses a default
# ==============================================================================
PART=B; say "B. the reader stops instead of using a default"
stops() { # label, then reader arguments. Must exit non-zero, say ABORT, and never reach the next line.
    local label="$1" out rc; shift
    out="$(reader "$@" -- 'echo "REACHED prefix=$FLEET_PREFIX jail=$FLEET_JAIL_PREFIX name=$FLEET_NAME"' 2>&1)"; rc=$?
    if [ "$rc" != 0 ] && printf '%s' "$out" | grep -q '^ABORT' && ! printf '%s' "$out" | grep -q 'REACHED'; then ok "$label"
    else bad "$label" "exit $rc: $(printf '%s' "$out" | tail -1 | cut -c1-90)"; fi
}
variant() { perl -0p -e "$2" "$NEW/fleet.config.ts" > "$T/cfg-$1.ts"; cmp -s "$T/cfg-$1.ts" "$NEW/fleet.config.ts" && echo "the config variant $1 changed nothing" >&2; printf '%s' "FLEET_CONFIG_FILE=$T/cfg-$1.ts"; }
same "control: with the config as it is, the next line is reached" "$(reader -- 'echo REACHED' 2>&1)" "REACHED"
stops "no config file"                                   "FLEET_CONFIG_FILE=$T/none.ts"
stops "the prefix is in the file twice"                  "$(variant twice 's/^(\s*prefix: "[^"]*",)$/$1\n$1/m')"
stops "the prefix is not in the file"                    "$(variant gone 's/^\s*prefix: "[^"]*",\n//m')"
stops "the prefix has a capital and a hyphen"            "$(variant caps 's/^(\s*prefix: ")[^"]*(",)$/$1Bad-Name$2/m')"
stops "the prefix is empty"                              "$(variant empty 's/^(\s*prefix: ")[^"]*(",)$/$1$2/m')"
stops "the prefix is 16 characters"                      "$(variant long 's/^(\s*prefix: ")[^"]*(",)$/$1abcdefghijklmnop$2/m')"
same "control: a prefix and a jail prefix of 15 characters are taken" "$(reader "$(variant long15 's/^(\s*prefix: ")[^"]*(",)$/$1abcdefghijklmno$2/m; s/^(\s*jailPrefix: ")[^"]*(",)$/$1abcdefghijklmno$2/m')" -- 'echo "$FLEET_PREFIX $FLEET_JAIL_PREFIX $FLEET_JAIL_SITE_CHARS"' 2>&1)" "abcdefghijklmno abcdefghijklmno 1"
stops "the jail prefix starts with a digit"              "$(variant jdigit 's/^(\s*jailPrefix: ")[^"]*(",)$/${1}9lives$2/m')"
stops "the jail prefix is 17 characters"                 "$(variant jlong 's/^(\s*jailPrefix: ")[^"]*(",)$/$1abcdefghijklmnopq$2/m')"
stops "the jail prefix is 16 characters"                 "$(variant jfull 's/^(\s*jailPrefix: ")[^"]*(",)$/$1abcdefghijklmnop$2/m')"
stops "the jail prefix is in the file twice"             "$(variant jtwice 's/^(\s*jailPrefix: "[^"]*",)$/$1\n$1/m')"
stops "the product name has a slash in it"               "$(variant name 's/^(  name: ")[^"]*(",)$/$1A\/B$2/m')"
stops "a bad prefix in the environment is not replaced by the file's" "FLEET_PREFIX=Has Space"
stops "a bad jail prefix in the environment is not replaced either"   "FLEET_JAIL_PREFIX=no-hyphens"
printf 'echo __FLEET_PREFIX__ __FLEET_SOMETHING_NEW__\n' > "$T/leftover.sh"
same "text with a placeholder nobody fills is refused, not sent" "$(reader -- 'fleet_names_script "$0" >/dev/null 2>&1; echo $?' 2>&1 | tail -1)" "1"
same "control: text with only known placeholders is handed back" "$(reader FLEET_PREFIX=acme FLEET_JAIL_PREFIX=zq FLEET_NAME=X -- "printf 'echo __FLEET_PREFIX__ __FLEET_JAIL_PREFIX__\n' > '$T/known.sh'; fleet_names_script '$T/known.sh'" 2>&1)" "echo acme zq"
# A server program that arrives unfilled must refuse on its first lines. Run with no commands
# on the PATH at all, so a check that failed to stop it could still do nothing.
for f in fleet-fail2ban-apply.remote.sh fleet-server-snapshot.remote.sh fleet-server-restore.remote.sh fleet-site-hold.remote.sh install-fleet-sso-agent.remote.sh; do
    out="$(env -i PATH="$T/nobin" HOME="$T/home" /bin/bash "$NEW/scripts/$f" status shop.example.com 203.0.113.21 2>&1)"; rc=$?
    yes "$f refuses to run unfilled" "$([ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'arrived without its \(names\|values\) filled in' && echo 1 || echo 0)" "exit $rc: $(printf '%s' "$out" | head -1 | cut -c1-80)"
done
g=0; gbad=""
for f in "$NEW"/scripts/*.sh; do
    case "$f" in *test*) continue ;; esac
    grep -q '# names-guard' "$f" || continue
    g=$((g + $(grep -c '# names-guard' "$f"))); guards_ok "$f" || gbad="$gbad $(basename "$f")"
done
yes "every filled-in check has the one fixed shape ($g of them)" "$([ -z "$gbad" ] && [ "$g" -ge 8 ] && echo 1 || echo 0)" "not that shape in:$gbad"
unguarded=""
for f in "$NEW"/scripts/*.remote.sh; do grep -q '__FLEET_[A-Z_]*__' "$f" && ! grep -q '# names-guard' "$f" && unguarded="$unguarded $(basename "$f")"; done
yes "every server program that carries placeholders checks it was filled in" "$([ -z "$unguarded" ] && echo 1 || echo 0)" "none in:$unguarded"

# ==============================================================================
# C. Before and after, against the baseline commit
# ==============================================================================
PART=C; HAVE_BASELINE=0; OP=""; OJ=""; ON=""; OREF=""; OURL=""; OLABEL=""
if [ "$WANT_BASELINE" = 0 ]; then
    say "C. before and after"; skip "you asked for --no-baseline: nothing here says the scripts still install what they did"
elif [ -z "$BASELINE" ] || ! git -C "$REPO" cat-file -e "$BASELINE^{commit}" 2>/dev/null; then
    say "C. before and after"
    if [ "$REQUIRE_BASELINE" = 1 ]; then
        if [ -n "$BASELINE" ]; then why="the baseline commit $BASELINE is not in this history"; else why="no baseline commit is set (FLEET_NAMES_BASELINE or ~/.config/fleet/names-baseline)"; fi
        bad "$why, so before and after cannot be compared" "you asked for --require-baseline"
    else
        skip "no baseline commit${BASELINE:+ ($BASELINE is not in this history)}, so before and after were not compared. That part is only for an install whose scripts spelled the names out before they became settings"
    fi
else
    HAVE_BASELINE=1
    OLD="$T/old"; mkdir -p "$OLD"
    git -C "$REPO" archive "$BASELINE" scripts | tar -x -C "$OLD"; rm -f "$OLD/scripts/servers.local"
    o() { cat "$OLD/scripts/$1"; }
    # The baseline's names, read out of its own scripts.
    OP=$(o install-7g-logrotate.sh | sed -n 's|^CONFIG_PATH="/etc/logrotate.d/\(.*\)-7g-logs"$|\1|p')
    ON=$(o install-7g-logrotate.sh | sed -n "s|^STANDARD_RULE='# Managed by \(.*\) — 7G WAF log rotation\.\$|\1|p")
    OJ=$(o fleet-fail2ban-apply.remote.sh | sed -n "s/.*printf '\([a-z0-9]*\)-%s-%s'.*/\1/p" | head -1)
    OURL=$(o install-fleet-sso-agent.remote.sh | sed -n 's/^Documentation=//p' | head -1)
    OLABEL=$(o install-waf-refresh.sh | sed -n 's/^LABEL="\(.*\)"$/\1/p')
    OLOG=$(o install-waf-refresh.sh | sed -n 's/^LOG="\(.*\)"$/\1/p')
    OSB=$(o telemetry-agent.sh | sed -n 's/^SUPABASE_URL="\(.*\)"$/\1/p'); OKEY=$(o telemetry-agent.sh | sed -n 's/^SUPABASE_KEY="\(.*\)"$/\1/p')
    OREF=$(printf '%s' "$OSB" | sed -n 's|^https://\([a-z0-9]*\)\..*|\1|p')
    OPU=$(printf '%s' "$OP" | tr 'a-z' 'A-Z')
    say "C. before ($BASELINE) and after"
    yes "the baseline's seven values could be read out of its scripts" "$([ -n "$OP" ] && [ -n "$ON" ] && [ -n "$OJ" ] && [ -n "$OURL" ] && [ -n "$OLABEL" ] && [ -n "$OSB" ] && [ -n "$OKEY" ] && echo 1 || echo 0)"
    if [ "$(printf '%s\n' "$OP" "$OJ" "$ON" "$OURL" "$OLABEL")" = "$APP" ]; then
        ok "fleet.config.ts holds the baseline's five names, so the scripts are compared exactly as this checkout runs them"
        SET_ENV=("FLEET_SUPABASE_URL=$OSB" "FLEET_SUPABASE_ANON_KEY=$OKEY")
    else
        skip "fleet.config.ts is not the baseline's deployment: the comparison below is made with the baseline's names handed in, and says nothing about this config"
        SET_ENV=("FLEET_PREFIX=$OP" "FLEET_JAIL_PREFIX=$OJ" "FLEET_NAME=$ON" "FLEET_REPO_URL=$OURL" "FLEET_WAF_REFRESH_LABEL=$OLABEL" "FLEET_SUPABASE_URL=$OSB" "FLEET_SUPABASE_ANON_KEY=$OKEY")
    fi
    # as_old <file>: the baseline's text with the one internal name that was renamed (a here-document tag).
    # Two lines the staging probe prints to the person running it were reworded on purpose (they named one
    # team's helper). Those two, and only those, are read in the baseline as they are worded now.
    as_old() { sed -e "s/${OPU}_RESTORE_PLAN/FLEET_RESTORE_PLAN/g" \
        -e 's/^  3\. Tell [A-Za-z]* two words: whether/  3. Note two things: whether/' \
        -e 's/Paste everything above back to [A-Za-z]*; it holds no working link/Everything above is safe to share with whoever is helping you; it holds no working link/' "$1"; }
    same_program() { # label, old file, new file (already filled)
        local a="$T/cmp-a" b="$T/cmp-b"
        as_old "$2" > "$a.sh"; strip_guard "$3" > "$b.sh"
        if canon "$a.sh" > "$a" && canon "$b.sh" > "$b" && cmp -s "$a" "$b"; then return 0; fi
        return 1
    }
    fill() { reader "${SET_ENV[@]}" -- "fleet_names_script '$NEW/scripts/$1' -e \"s|__FLEET_REPO_URL__|\$(fleet_repo_url)|g\" -e \"s|__FLEET_SUPABASE_URL__|\$FLEET_SUPABASE_URL|g\" -e \"s|__FLEET_SUPABASE_ANON_KEY__|\$FLEET_SUPABASE_ANON_KEY|g\""; }

    # C1. Each server program, filled in, against its baseline.
    np=0; nbad=""
    for f in "$OLD"/scripts/*.remote.sh; do
        b=$(basename "$f"); [ -r "$NEW/scripts/$b" ] || { nbad="$nbad $b(gone)"; continue; }
        fill "$b" > "$T/filled-$b" 2>/dev/null || { nbad="$nbad $b(not-filled)"; continue; }
        np=$((np+1)); same_program "$b" "$f" "$T/filled-$b" || nbad="$nbad $b"
    done
    yes "C1 the $np server programs, filled in, are the baseline's programs as bash reads them" "$([ -z "$nbad" ] && [ "$np" -ge 5 ] && echo 1 || echo 0)" "differs:$nbad"
    fill telemetry-agent.sh > "$T/agent.filled" 2>/dev/null
    yes "C1 the telemetry agent, filled in, is the baseline's file byte for byte ($(wc -c < "$OLD/scripts/telemetry-agent.sh" | tr -d ' ') bytes)" "$(cmp -s "$T/agent.filled" "$OLD/scripts/telemetry-agent.sh" && echo 1 || echo 0)"
    printf 'x\n' >> "$T/agent.filled"
    yes "C1 control: one byte more in the agent is noticed" "$(cmp -s "$T/agent.filled" "$OLD/scripts/telemetry-agent.sh" && echo 0 || echo 1)"
    { cat "$OLD/scripts/fleet-site-hold.remote.sh"; printf '# a comment\n'; } > "$T/c-comment.sh"; { cat "$OLD/scripts/fleet-site-hold.remote.sh"; printf 'cat <<X\n# not a comment\nX\n'; } > "$T/c-here.sh"; { cat "$OLD/scripts/fleet-site-hold.remote.sh"; printf 'cat <<X\n# not a comment.\nX\n'; } > "$T/c-here2.sh"
    yes "C1 control: a comment more is not a difference" "$(same_program x "$OLD/scripts/fleet-site-hold.remote.sh" "$T/c-comment.sh" && echo 1 || echo 0)"
    yes "C1 control: one character inside a here-document is a difference, even on a line that starts with #" "$(same_program x "$T/c-here.sh" "$T/c-here2.sh" && echo 0 || echo 1)"

    # C2. What every script sends, before and after.
    CO="$T/cap-old"; keep=("${SET_ENV[@]}"); SET_ENV=("FLEET_NAMES_TEST=1")
    run_cases "$OLD" "$CO" "$OLD/scripts/telemetry-agent.sh" self; SET_ENV=("${keep[@]}")
    CN="$T/cap-new"; run_cases "$NEW" "$CN" "$OLD/scripts/telemetry-agent.sh" "$(biggest "$CO/rotate-set")"
    # Host keys. The baseline connected with StrictHostKeyChecking=no. Every script now takes two options from
    # lib-fleet-hostkeys.sh: accept a key the first time, refuse another one after, and keep keys in Fleet's own
    # file. A send is compared with the baseline's only after those two options, in exactly this shape and naming
    # exactly that file, are read as the baseline's one. Everything else in the arguments must be byte for byte.
    KHN="$T/home/.config/fleet/known_hosts"
    hostkey_args_back() { # <the new arguments> <out>: succeeds only when the shape was there exactly once
        KHN="$KHN" perl -0pe 'BEGIN { $n = 0 } $n += s/(^|\n)-o\nStrictHostKeyChecking=accept-new\n-o\nUserKnownHostsFile=\Q$ENV{KHN}\E\n/$1-o\nStrictHostKeyChecking=no\n/g; END { $? = ($n == 1 ? 0 : 1) }' "$1" > "$2"
    }
    # Two later changes in what is sent are held to one fixed text each and, only where the text is exactly
    # that, read as the baseline's: the agent update says whether it made a copy of the old agent, and the 7G
    # log-rotation program matches only rules naming a per-site /var/www/.../7g.log. put_back_sends <file>
    # puts them back in that file and prints what it put back.
    put_back_sends() {
        python3 - "$1" <<'PUTSEND'
import sys
p = sys.argv[1]; text = open(p).read(); did = []
backup_now = 'if [ -f /root/telemetry-agent.sh ]; then cp /root/telemetry-agent.sh /root/telemetry-agent.sh.bak && echo "backup=made"; else echo "backup=none"; fi\n'
backup_was = '[ -f /root/telemetry-agent.sh ] && cp /root/telemetry-agent.sh /root/telemetry-agent.sh.bak\n'
if text.count(backup_now) == 1 and text.count(backup_was) == 0:
    text = text.replace(backup_now, backup_was); did.append("backup")
match_now = "grep -lsE '/var/www/[^[:space:]]*7g\\.log' /etc/logrotate.d/*"
match_was = "grep -ls '7g\\.log' /etc/logrotate.d/*"
if text.count(match_now) in (1, 2) and text.count(match_was) == 0:   # the audit and --set each carry one
    text = text.replace(match_now, match_was); did.append("match")
open(p, "w").write(text)
print(" ".join(did))
PUTSEND
    }
    ncase=0; nsent=0; quiet_cases=""; argbad=""; progbad=""; countbad=""; hkbad=""; nshape=0; sendsback=""
    for d in "$CO"/*/; do
        c=$(basename "$d"); ncase=$((ncase+1)); a=$(cat "$CO/$c/count" 2>/dev/null || echo 0); b=$(cat "$CN/$c/count" 2>/dev/null || echo 0)
        [ "$a" = "$b" ] || { countbad="$countbad $c($a,$b)"; continue; }
        [ "$a" -ge 1 ] || { quiet_cases="$quiet_cases $c"; continue; }
        i=1; while [ "$i" -le "$a" ]; do
            nsent=$((nsent+1))
            if hostkey_args_back "$CN/$c/call-$i.args" "$T/args-back"; then nshape=$((nshape+1)); else hkbad="$hkbad $c#$i"; fi
            cmp -s "$CO/$c/call-$i.args" "$T/args-back" || argbad="$argbad $c#$i"
            guards_ok "$CN/$c/call-$i.stdin" || progbad="$progbad $c#$i(check-shape)"
            cp "$CN/$c/call-$i.stdin" "$T/stdin-back"
            for w in $(put_back_sends "$T/stdin-back"); do sendsback="$sendsback $c:$w"; done
            same_program x "$CO/$c/call-$i.stdin" "$T/stdin-back" || progbad="$progbad $c#$i"
            i=$((i+1))
        done
    done
    yes "C2 every script sends as many times as it did ($ncase script-and-mode runs, $nsent sends)" "$([ -z "$countbad" ] && [ "$nsent" -ge 30 ] && echo 1 || echo 0)" "differs (before,after):$countbad"
    yes "C2 no run sent nothing, so none was compared blind" "$([ -z "$quiet_cases" ] && echo 1 || echo 0)" "sent nothing:$quiet_cases"
    yes "C2 every send carries the two host-key options once, in the one fixed shape, naming Fleet's own file ($nshape of $nsent sends)" "$([ -z "$hkbad" ] && [ "$nshape" = "$nsent" ] && [ "$nsent" -ge 30 ] && echo 1 || echo 0)" "not that shape:$hkbad"
    yes "C2 control: the baseline's own arguments, which check no host key, do not pass for that shape" "$(hostkey_args_back "$CO/f2b-audit/call-1.args" "$T/args-control" && echo 0 || echo 1)"
    yes "C2 with those two read as the baseline's one, the ssh arguments are the same byte for byte ($(bytes "$CN" ) bytes captured in all)" "$([ -z "$argbad" ] && echo 1 || echo 0)" "differs:$argbad"
    yes "C2 the program each send carries is the baseline's, as bash reads it" "$([ -z "$progbad" ] && echo 1 || echo 0)" "differs:$progbad"
    same "C2 what was read as the baseline's for that: the agent update's copy line, the 7G log-rotation match in its audit and its --set" "$(printf '%s\n' $sendsback | sort -u | tr '\n' ' ' | sed 's/ $//')" "agent-update:backup rotate-audit:match rotate-set:match"
    # A server's Cloudflare token: the baseline read it from its helper by name. Now it comes through the
    # token setting, and must be asked for under the same name, once, and travel the same way.
    tbad=""; tn=0
    for c in f2b-live f2b-proof; do
        tn=$((tn+1)); a="$(tail -1 "$CO/$c/secret.log" 2>/dev/null)"; b="$(cat "$CN/$c/secret.log" 2>/dev/null)"
        [ -n "$a" ] && [ "$a" = "$b" ] || tbad="$tbad $c"
    done
    yes "C2 a server's token is asked for once, under the name the baseline read it by ($tn runs that need one)" "$([ -z "$tbad" ] && echo 1 || echo 0)" "differs:$tbad"
    yes "C2 the token travels inside the text sent, and is in no ssh argument and nothing printed" "$(grep -qx "CF_TOKEN='stand-in-secret-value'" "$CN/f2b-live/call-2.stdin" && grep -qx "CF_TOKEN='stand-in-secret-value'" "$CN/f2b-proof/call-1.stdin" && ! cat "$CN"/*/call-*.args "$CN"/*/stdout | grep -qaF 'stand-in-secret-value' && echo 1 || echo 0)"
    yes "C2 no run that needs no token asks for one" "$([ "$(ls "$CN"/*/secret.log 2>/dev/null | wc -l | tr -d ' ')" = "$tn" ] && echo 1 || echo 0)" "$(ls "$CN"/*/secret.log 2>/dev/null | sed "s|$CN/||" | tr '\n' ' ')"

    # C3. The files that end up on a server.
    nf=0; fbad=""
    for f in "$CO"/*/*.file-*; do
        [ -r "$f" ] || continue; nf=$((nf+1)); cmp -s "$f" "$CN/${f#"$CO"/}" || fbad="$fbad ${f#"$CO"/}"
    done
    yes "C3 the $nf files carried inside ssh arguments (the agent, the certbot hooks, the logrotate rule) are byte for byte the same" "$([ -z "$fbad" ] && [ "$nf" -ge 4 ] && echo 1 || echo 0)" "differs:$fbad"
    yes "C3 the agent a server receives is the baseline's file" "$(cmp -s "$(biggest "$CN/agent-update")" "$OLD/scripts/telemetry-agent.sh" && echo 1 || echo 0)"
    generate "$OLD/scripts/fleet-fail2ban-apply.remote.sh" "$T/gen-old"; generate "$T/filled-fleet-fail2ban-apply.remote.sh" "$T/gen-new"
    yes "C3 the Fail2Ban program writes the same $(count "$T/gen-old") files, byte for byte (action, ban program, jails, filters)" "$([ "$(count "$T/gen-old")" -ge 6 ] && diff -r "$T/gen-old" "$T/gen-new" >/dev/null 2>&1 && cmp -s "$T/gen-old.out" "$T/gen-new.out" && echo 1 || echo 0)" "$(diff -rq "$T/gen-old" "$T/gen-new" 2>&1 | head -2 | tr '\n' ' ')"

    # C4. Names that stay on this Mac, and scripts that only changed by taking the setting.
    same "C4 the WAF refresh job keeps its label" "$(reader "${SET_ENV[@]}" -- 'fleet_waf_refresh_label' 2>&1)" "$OLABEL"
    same "C4 the WAF refresh job keeps its log file" "$(sed -n 's/^LOG="\(.*\)"$/\1/p' "$NEW/scripts/install-waf-refresh.sh" | sed "s/\$FLEET_PREFIX/$(reader "${SET_ENV[@]}" -- 'printf %s "$FLEET_PREFIX"')/")" "$OLOG"
    same "C4 a snapshot keeps the name of its jail count" "$(cd "$NEW/scripts" && FLEET_PREFIX="$(reader "${SET_ENV[@]}" -- 'printf %s "$FLEET_PREFIX"')" python3 -c 'import importlib.util as u; s=u.spec_from_file_location("lib","fleet-server-snapshot-lib.py"); m=u.module_from_spec(s); s.loader.exec_module(m); print(m.jails_key())' 2>&1)" "jails_$OP"
    # with_setting <file>: the new script with the setting put back where the baseline spelled it.
    # The folder runs are kept in is a setting too: its one line, which reads it through the one function in
    # lib-fleet-output.sh, is dropped (and held to its exact shape below), and the variable it sets is read
    # as the folder the baseline spelled out.
    out_line='. "$(dirname "$0")/lib-fleet-output.sh" || exit 1; FLEET_OUT="$(fleet_output_dir)"'
    out_lib="$NEW/scripts/lib-fleet-output.sh"
    # folder_read <VAR=value>...: the folder that one line sets, run the way a script runs it.
    folder_read() { env -i PATH="$RUNPATH" "$@" bash -c "$out_line"'; printf %s "$FLEET_OUT"' "$NEW/scripts/a-script.sh" 2>/dev/null; }
    OBK="$(o waf-refresh.sh | sed -n 's/^BACKUPS="\(.*\)"$/\1/p')"          # as the baseline wrote it: $HOME/...
    with_setting() { grep -v '^\. ".*lib-fleet-names\.sh"$' "$NEW/scripts/$1" | grep -vF "$out_line" | sed "s/\${FLEET_PREFIX}/$OP/g; s/\$FLEET_PREFIX/$OP/g" | OBK="$OBK" perl -pe 's/\$FLEET_OUT\b/$ENV{OBK}/g'; }
    put_back_env_lines() {  # <file>: the block that reads two settings as text -> the baseline's five lines that ran the file
        python3 - "$1" <<'PUTBACK'
import sys
p = sys.argv[1]; lines = open(p).read().split("\n")
try:
    a = lines.index('# shellcheck source=lib-fleet-project.sh')
    b = next(i for i in range(a, len(lines)) if lines[i].startswith('[ -n "$NEXT_PUBLIC_SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] ||'))
except (ValueError, StopIteration):
    sys.exit(0)  # not found: the file is compared as it is, and differs
block = [l for l in lines[a:b + 1] if not l.startswith("#")]
if len(block) != 4 or block[0] != '. "$ROOT/scripts/lib-fleet-project.sh"' or block[1] != 'NEXT_PUBLIC_SUPABASE_URL="$(fleet_env_value NEXT_PUBLIC_SUPABASE_URL)"' or block[2] != 'SUPABASE_SERVICE_ROLE_KEY="$(fleet_env_value SUPABASE_SERVICE_ROLE_KEY)"':
    sys.exit(0)
old = ['ENV_FILE="$ROOT/.env.local"',
       '[ -r "$ENV_FILE" ] || { echo "ABORT: cannot read $ENV_FILE (needs SUPABASE_SERVICE_ROLE_KEY)"; exit 1; }',
       'set -a; . "$ENV_FILE"; set +a',
       ': "${NEXT_PUBLIC_SUPABASE_URL:?missing in .env.local}"',
       ': "${SUPABASE_SERVICE_ROLE_KEY:?missing in .env.local}"']
open(p, "w").write("\n".join(lines[:a] + old + lines[b + 1:]))
PUTBACK
    }
    # The daily WAF job takes the inventory a second time when the first fails. The baseline stopped at
    # the first failed inventory and tried again only after a refused ingest. The loop is held to this
    # exact text; for the comparison, and only where the text is exactly this, the baseline's loop is put back.
    cat > "$T/retry-loop" <<'RETRYLOOP'
PAUSE="${WAF_REFRESH_RETRY_SECONDS:-60}"
case "$PAUSE" in ''|*[!0-9]*) stop "WAF_REFRESH_RETRY_SECONDS must be a whole number of seconds" ;; esac
attempt=1
while :; do
  if ! python3 "$GENERATOR" --out "$OUT"; then
    why="the inventory script failed"
  elif [ ! -s "$OUT/report.json" ]; then
    stop "the inventory wrote no report.json"
  elif node --experimental-strip-types --no-warnings scripts/ingest-waf-report.ts "$RUN" --unattended $DRY; then
    break
  else
    why="the ingest refused this run"
  fi
  [ "$attempt" -ge 2 ] && stop "$why twice (reason above). Run folder kept: $RUN"
  attempt=$((attempt + 1))
  say "$why; taking the inventory once more in $PAUSE seconds"
  sleep "$PAUSE"
done
RETRYLOOP
    put_back_retry_loop() {  # <file> <the baseline's file>
        python3 - "$1" "$2" "$T/retry-loop" <<'PUTLOOP'
import re, sys
p, old, want = sys.argv[1:4]
text = open(p).read(); now = open(want).read()
was = re.search(r"^attempt=1\n.*?^done\n", open(old).read(), re.S | re.M)
if was and text.count(now) == 1:   # anything else: the file is compared as it is, and differs
    open(p, "w").write(text.replace(now, was.group(0)))
PUTLOOP
    }
    # Three later changes are held to one fixed text each and, only where the text is exactly that, read as the
    # baseline's for this comparison: (1) the one line that takes the host-key options from lib-fleet-hostkeys.sh,
    # and the variable it sets where the baseline wrote StrictHostKeyChecking=no; (2) in the runner, the three
    # lines tagged "# host-keys"; in the site copy, its first connection, which now names a changed host key;
    # (3) in the token script, the service key sent to curl on standard input instead of as two arguments.
    # put_back_hardening <file> <its name> <the baseline's file> prints what it put back, one word per change.
    cat > "$T/first-contact" <<'FIRSTCONTACT'
SSHERR=$(mktemp "${TMPDIR:-/tmp}/fleet-site-ssh.XXXXXX") || exit 1; trap 'rm -f "$SSHERR"' EXIT
has_ip() {
    local rc
    "$1" "hostname -I" < /dev/null 2>"$SSHERR" | tr ' ' '\n' | grep -qxF "$2"; rc=$?
    cat "$SSHERR" >&2
    if fleet_hostkey_refusal "$SSHERR" "$2"; then exit 1; fi
    return "$rc"
}
FIRSTCONTACT
    hostkey_line='. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with'
    put_back_hardening() {
        HOSTKEY_LINE="$hostkey_line" python3 - "$1" "$2" "$3" "$T/first-contact" <<'PUTHARD'
import os, re, sys
p, name, oldp, first = sys.argv[1:5]
text = open(p).read(); old = open(oldp).read(); did = []
line = "\n" + os.environ["HOSTKEY_LINE"] + "\n"
use = '="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 '
if text.count(line) == 1 and text.count("FLEET_HOSTKEY_OPTS") == 2 and text.count(use) == 1:
    text = text.replace(line, "\n").replace(use, '="-o StrictHostKeyChecking=no -o ConnectTimeout=10 '); did.append("options")
if name == "lib-fleet-ssh.sh":
    tagged = ['. "$(dirname "${BASH_SOURCE[0]}")/lib-fleet-hostkeys.sh" || return 1   # host-keys\n',
              '    fleet_hostkey_is_refusal "$errf" && return 1   # host-keys\n',
              '    fleet_hostkey_refusal "$errf" "$ip" || true   # host-keys\n']
    if text.count("# host-keys") == 3 and text.count("fleet_hostkey") == 2 and all(text.count("\n" + t) == 1 for t in tagged):
        for t in tagged: text = text.replace("\n" + t, "\n")
        did.append("runner")
if name == "fleet-site-final-copy.sh":
    now = open(first).read()
    was = re.search(r"^has_ip\(\) \{ .*\}\n", old, re.M); cnt = re.search(r"^CNT=\$\(mktemp .*; trap 'rm -f \"\$CNT\"' EXIT\n", old, re.M)
    if was and cnt:
        cnt_now = cnt.group(0).replace("""'rm -f "$CNT"' EXIT""", """'rm -f "$CNT" "$SSHERR"' EXIT""")
        if text.count(now) == 1 and text.count(cnt_now) == 1 and text.count("SSHERR") == now.count("SSHERR") + 1 and text.count("fleet_hostkey") == 1:
            text = text.replace(now, was.group(0)).replace(cnt_now, cnt.group(0)); did.append("first-contact")
if name == "provision-agent-tokens.sh":
    fn = """service_headers() { printf 'apikey: %s\\nAuthorization: Bearer %s\\n' "$SK" "$SK"; }\n"""
    two = '-H "apikey: $SK" -H "Authorization: Bearer $SK"'
    swaps = [("\n" + fn, "\n"),
             ("        REG=$(service_headers | curl -s --max-time 20 ", "        REG=$(curl -s --max-time 20 "),
             ("\n                -H @-)\n", "\n                " + two + ")\n"),
             ("    CODE=$(service_headers | curl -s -o /tmp/prov.out ", "    CODE=$(curl -s -o /tmp/prov.out "),
             ("\n        -H @- \\\n", "\n        " + two + " \\\n")]
    if text.count("service_headers") == 3 and all(text.count(a) == 1 for a, _ in swaps):
        for a, b in swaps: text = text.replace(a, b)
        did.append("headers")
    six = (" \\\n       && echo \"$FLEET_SSH_OUT\" | grep -q 'run: Fail2Ban report synced' \\\n"
           "       && echo \"$FLEET_SSH_OUT\" | grep -q 'run: WAF report synced' \\\n"
           "       && echo \"$FLEET_SSH_OUT\" | grep -q 'run: OPcache report synced'; then\n"
           "        echo \"   ✓ token active — all six reporters authenticated (telemetry, hardware, firewall, Fail2Ban, WAF, OPcache)\"\n")
    three = "; then\n        echo \"   ✓ token active — all three reporters authenticated\"\n"
    if text.count(six) == 1 and "all three reporters" not in text:
        text = text.replace(six, three); did.append("reporters")
    closing = '    apply) echo "Every server should now show a recent last_used_at. The database refuses reports without a token." ;;\n'
    was_closing = ('    apply) echo "When every server shows a recent last_used_at, apply agent_auth_strict.sql"\n'
                   '           echo "to start REJECTING unauthenticated reports." ;;\n')
    if text.count(closing) == 1 and "agent_auth_strict" not in text:
        text = text.replace(closing, was_closing); did.append("closing")
if name == "fleet-site-final-copy.sh":
    lib = '# shellcheck source=lib-sql-definer.sh\n. "$HERE/lib-sql-definer.sh"\n'
    start = "# Views, triggers and routines name the old server's database user as DEFINER, and\n"
    end = '[ "${got:-x}" = "${views:-y}" ] || die "the copy does not have every view in the export; look before going on"\n'
    was_load = re.search(r'^new "gunzip -c \$D/final-\$TS\.sql\.gz \| \$WP db import - 2>&1 \| tail -2 \| cut -c1-200" < /dev/null\n', old, re.M)
    was_usage = re.search(r"sed -n '2,\d+p' \"\$0\"", old)
    usage_now = re.findall(r"sed -n '2,\d+p' \"\$0\"", text)
    if was_load and was_usage and len(usage_now) == 1 and text.count(lib) == 1 and text.count(start) == 1 and text.count(end) == 1 and text.index(start) < text.index(end):
        a = text.index(start); b = text.index(end) + len(end)
        text = text[:a] + was_load.group(0) + text[b:]
        # The usage text at the top grew by the lines that describe this step.
        text = text.replace(lib, "").replace(usage_now[0], was_usage.group(0))
        did.append("definer")
open(p, "w").write(text)
print(" ".join(name + ":" + d for d in did))
PUTHARD
    }
    loop_is() { python3 -c 'import sys; sys.exit(0 if open(sys.argv[1]).read().count(open(sys.argv[2]).read()) == 1 else 1)' "$1" "$T/retry-loop"; }
    sbad=""; ns=0; hardened=""
    for f in waf-refresh.sh fleet-fail2ban.sh lock-web-ports-cloudflare.sh lib-fleet-ssh.sh lib-fleet-servers.sh provision-agent-tokens.sh fleet-site-final-copy.sh; do
        ns=$((ns+1)); with_setting "$f" > "$T/s-new.sh"
        # provision-agent-tokens.sh used to RUN the settings file to get two values out of it. It reads them as text
        # now (scripts/test-env-file.sh proves that). Put the baseline's five lines back for this comparison only.
        [ "$f" != provision-agent-tokens.sh ] || put_back_env_lines "$T/s-new.sh"
        [ "$f" != waf-refresh.sh ] || put_back_retry_loop "$T/s-new.sh" "$OLD/scripts/$f"
        hardened="$hardened $(put_back_hardening "$T/s-new.sh" "$f" "$OLD/scripts/$f")"
        canon "$OLD/scripts/$f" > "$T/s-old" && canon "$T/s-new.sh" > "$T/s-new" || { sbad="$sbad $f(not-a-program)"; continue; }
        # The only lines allowed to differ are ones that print a made-up example to the person at the keyboard.
        # ... and the one that names the operator's SSH key, which is a setting now (checked on its own, below).
        # ... and, in the daily WAF job alone, the default inventory script and the list of tools it needs:
        # the inventory is in this repository now and no longer calls the baseline's token helper (both checked below).
        allow='^$'; [ "$f" != waf-refresh.sh ] || allow='^[<>] +(GENERATOR="\$\{WAF_INVENTORY:-[^";]*"|for tool in (secret )?python3 node curl);?$'
        diff "$T/s-old" "$T/s-new" | grep '^[<>]' | grep -vE '^[<>] +KEY_FP=' | grep -vE "$allow" | grep -vqE '^[<>] +echo ".*(like|first:) .*";?$' && sbad="$sbad $f"
    done
    yes "C4 $ns scripts are the baseline's once the setting is put back (bar a made-up example in a printed message)" "$([ -z "$sbad" ] && echo 1 || echo 0)" "differs:$sbad"
    same "C4 what was read as the baseline's for that: the host-key options in 4 scripts, the runner's three lines, the site copy's first connection and its DEFINER load, the token script's two headers, its six reporters and its closing line" "$(echo $hardened)" "fleet-fail2ban.sh:options lock-web-ports-cloudflare.sh:options lib-fleet-ssh.sh:runner provision-agent-tokens.sh:options provision-agent-tokens.sh:headers provision-agent-tokens.sh:reporters provision-agent-tokens.sh:closing fleet-site-final-copy.sh:options fleet-site-final-copy.sh:first-contact fleet-site-final-copy.sh:definer"
    hn=0; hbad=""
    for f in "$NEW"/scripts/*.sh; do
        case "$(basename "$f")" in test-*|lib-fleet-hostkeys.sh) continue ;; esac
        grep -q 'FLEET_HOSTKEY_OPTS' "$f" || continue; hn=$((hn+1))
        [ "$(grep -cxF "$hostkey_line" "$f")" = 1 ] && [ "$(grep -c 'FLEET_HOSTKEY_OPTS' "$f")" = 2 ] && [ "$(grep -cE '^(SSH_OPTS|SSHO)="\$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 ' "$f")" = 1 ] || hbad="$hbad $(basename "$f")"
    done
    yes "C4 the $hn scripts that connect all take the host-key options from the one definition, the same way" "$([ -z "$hbad" ] && [ "$hn" -ge 14 ] && echo 1 || echo 0)" "differs:$hbad"
    yes "C4 the token script reads its two settings as text and no longer runs the settings file" "$([ "$(grep -c 'fleet_env_value' "$NEW/scripts/provision-agent-tokens.sh")" = 2 ] && ! grep -qE '(^|;)[[:space:]]*(set -a|\.[[:space:]]+"\$ENV_FILE")' "$NEW/scripts/provision-agent-tokens.sh" && echo 1 || echo 0)"
    # The daily WAF job: its inventory script is the one in this repository unless WAF_INVENTORY names another.
    yes "C4 the daily WAF job runs the inventory in this repository by default, and WAF_INVENTORY still names another" "$([ "$(grep -c '^GENERATOR=' "$NEW/scripts/waf-refresh.sh")" = 1 ] && grep -qxF 'GENERATOR="${WAF_INVENTORY:-$REPO/scripts/waf-inventory.py}"' "$NEW/scripts/waf-refresh.sh" && [ -s "$NEW/scripts/waf-inventory.py" ] && echo 1 || echo 0)"
    yes "C4 the daily WAF job tries twice whichever half failed: its loop is the one fixed text, and the baseline's loop is not in it" "$(loop_is "$NEW/scripts/waf-refresh.sh" && [ "$(grep -c '^while :; do$' "$NEW/scripts/waf-refresh.sh")" = 1 ] && ! grep -qF '|| stop "the inventory script failed"' "$NEW/scripts/waf-refresh.sh" && echo 1 || echo 0)"
    cp "$NEW/scripts/waf-refresh.sh" "$T/loop-control.sh"; put_back_retry_loop "$T/loop-control.sh" "$OLD/scripts/waf-refresh.sh"
    yes "C4 control: with the baseline's loop put back, that check fails and the baseline's own line is there" "$(! loop_is "$T/loop-control.sh" && grep -qF '|| stop "the inventory script failed"' "$T/loop-control.sh" && echo 1 || echo 0)"
    yes "C4 the daily WAF job needs the tools it needed, less the baseline's own token helper" "$([ "$(grep -c '^for tool in ' "$NEW/scripts/waf-refresh.sh")" = 1 ] && grep -qxF 'for tool in python3 node curl; do' "$NEW/scripts/waf-refresh.sh" && echo 1 || echo 0)"
    # The folder: every script that keeps something on this machine reads it with the same one line, which
    # calls the one function in lib-fleet-output.sh; none reads the setting for itself, none spells a
    # folder out, and on this machine what they read must be the folder the baseline named.
    on=0; obad=""
    for f in "$NEW"/scripts/*.sh; do
        case "$f" in *test*) continue ;; esac
        grep -q 'FLEET_OUT=' "$f" || continue; on=$((on+1))
        [ "$(grep -c 'FLEET_OUT=' "$f")" = 1 ] && grep -qxF "$out_line   # the folder runs, audits and snapshots are kept in" "$f" || obad="$obad $(basename "$f")"
    done
    yes "C4 the $on scripts that keep runs, audits or snapshots on this machine all read the folder from the setting, the same way" "$([ -z "$obad" ] && [ "$on" -ge 5 ] && echo 1 || echo 0)" "differs:$obad"
    # Outside comments, the setting's two names (the variable and the file) are in the library and nowhere else.
    oown=""; oread=0
    for f in "$NEW"/scripts/*.sh; do
        case "$f" in *test*|"$out_lib") continue ;; esac
        oread=$((oread+1)); grep -v '^[[:space:]]*#' "$f" | grep -qE 'FLEET_OUTPUT_DIR|fleet/output-dir' && oown="$oown $(basename "$f")"
    done
    yes "C4 no script reads the folder setting for itself: outside comments its two names are only in lib-fleet-output.sh ($oread other scripts read)" "$([ -z "$oown" ] && [ "$oread" -ge 20 ] && [ "$(grep -v '^[[:space:]]*#' "$out_lib" | grep -cE 'FLEET_OUTPUT_DIR|fleet/output-dir')" -ge 2 ] && echo 1 || echo 0)" "also in:$oown"
    OBT="${OBK#\$HOME/}"
    yes "C4 the baseline's folder could be read, and no script names it" "$([ -n "$OBK" ] && [ "$OBT" != "$OBK" ] && ! grep -lF -e "$OBT" "$NEW"/scripts/* 2>/dev/null | grep -q . && echo 1 || echo 0)" "$(grep -lF -e "$OBT" "$NEW"/scripts/* 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
    HOUT="$(folder_read HOME="$HOME")"
    if [ "$HOUT" = "$HOME/.local/state/fleet" ]; then
        skip "C4 no folder is set on this machine, so runs are kept in the default one: not compared with the baseline's"
    else
        yes "C4 on this machine, runs, audits and snapshots are kept in the folder the baseline named" "$([ "$HOUT" = "$HOME/$OBT" ] && echo 1 || echo 0)" "they differ"
    fi
    yes "C4 with no folder set, a script keeps its runs under ~/.local/state/fleet" "$([ "$(folder_read HOME="$T/nohome")" = "$T/nohome/.local/state/fleet" ] && echo 1 || echo 0)"
    mkdir -p "$T/filehome/.config/fleet"; printf '%s\n' "$T/kept in a file" > "$T/filehome/.config/fleet/output-dir"
    yes "C4 a folder named in the settings file is the one used, spaces and all" "$([ "$(folder_read HOME="$T/filehome")" = "$T/kept in a file" ] && echo 1 || echo 0)"
    yes "C4 the environment's folder wins over the file" "$([ "$(folder_read HOME="$T/filehome" FLEET_OUTPUT_DIR=/from/env)" = "/from/env" ] && echo 1 || echo 0)"
    # On this machine: where a live run will find a server's token. Only looked at when the token command
    # set here is one this test has a stand-in for, so nothing real is ever run or read.
    HCMD="$(grep -vE '^[[:space:]]*(#.*)?$' "$HOME/.config/fleet/cloudflare-token-command" 2>/dev/null | head -1)"
    if [ -z "$HCMD" ]; then
        skip "C4 no token command is set on this machine, so where a live run finds a server's token here was not compared with the baseline's"
    elif [ ! -x "$T/bin/${HCMD%% *}" ]; then
        bad "C4 on this machine, a server's token is asked of the command the baseline called" "the token command set here is another one (not run)"
    else
        mkdir -p "$T/cap-here"
        env -i PATH="$RUNPATH" HOME="$HOME" CAP="$T/cap-here" bash -c '. "$1"; fleet_cf_token f2b-web1 TOK' x "$NEW/scripts/lib-fleet-token.sh" >/dev/null 2>&1
        same "C4 on this machine, a server's token is asked of the command the baseline called, by the same name" "$(cat "$T/cap-here/secret.log" 2>/dev/null)" "$(tail -1 "$CO/f2b-live/secret.log" 2>/dev/null)"
    fi
    # The SSH key's fingerprint left the scripts for a setting. No script may still carry one, and every script that names
    # the key must read it the same way; on this machine, what they read must be the key the baseline named.
    kfp_line='KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"'
    kn=0; kbad=""
    for f in "$NEW"/scripts/*.sh; do
        grep -q '^KEY_FP=' "$f" || continue; kn=$((kn+1))
        [ "$(grep -c '^KEY_FP=' "$f")" = 1 ] && grep -qF "$kfp_line" "$f" || kbad="$kbad $(basename "$f")"
    done
    yes "C4 the $kn scripts that name the operator's SSH key all read it from the setting, the same way" "$([ -z "$kbad" ] && [ "$kn" -ge 10 ] && echo 1 || echo 0)" "differs:$kbad"
    yes "C4 no script carries a key fingerprint of its own" "$(grep -lE 'SHA256:[A-Za-z0-9+/]{43}' "$NEW"/scripts/* 2>/dev/null | grep -q . && echo 0 || echo 1)" "$(grep -lE 'SHA256:[A-Za-z0-9+/]{43}' "$NEW"/scripts/* 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
    OFP="$(sed -n 's/^KEY_FP="\(SHA256:[A-Za-z0-9+\/]*\)".*/\1/p' "$OLD/scripts/fleet-fail2ban.sh" | head -1)"
    HFP="$(env -i PATH="$RUNPATH" HOME="$HOME" bash -c "$kfp_line"'; printf %s "$KEY_FP"' 2>/dev/null)"
    if [ "$HFP" = "SHA256:" ]; then
        skip "C4 no key fingerprint is set on this machine, so the scripts accept any key the agent holds: not compared with the baseline's"
    else
        yes "C4 on this machine, the scripts look for the same SSH key the baseline named" "$([ -n "$OFP" ] && [ "$HFP" = "$OFP" ] && echo 1 || echo 0)" "they differ (values not shown)"
    fi
    yes "C4 with no fingerprint set, a script accepts any key rather than none" "$([ "$(env -i PATH="$RUNPATH" HOME="$T/nohome" bash -c "$kfp_line"'; printf %s "$KEY_FP"' 2>/dev/null)" = "SHA256:" ] && echo 1 || echo 0)"
    yes "C4 the environment's fingerprint wins over the file" "$([ "$(env -i PATH="$RUNPATH" HOME="$HOME" FLEET_SSH_KEY_FP=SHA256:fromenv bash -c "$kfp_line"'; printf %s "$KEY_FP"' 2>/dev/null)" = "SHA256:fromenv" ] && echo 1 || echo 0)"
    # On this machine: what the installer and the two project scripts will read here.
    HERE_URL="$(env -i PATH="$RUNPATH" HOME="$HOME" bash -c '. "$1"; fleet_supabase_url' x "$TREE/scripts/lib-fleet-project.sh" 2>/dev/null)"
    if [ -n "$HERE_URL" ]; then
        yes "C4 on this machine, the installer reads the same database address and public key the baseline's agent carries" "$([ "$HERE_URL" = "$OSB" ] && [ "$(env -i PATH="$RUNPATH" HOME="$HOME" bash -c '. "$1"; fleet_supabase_anon_key' x "$TREE/scripts/lib-fleet-project.sh" 2>/dev/null)" = "$OKEY" ] && echo 1 || echo 0)" "they differ (values not shown)"
        same "C4 on this machine, the two project scripts read the baseline's project" "$([ "$(env -i PATH="$RUNPATH" HOME="$HOME" bash -c '. "$1"; fleet_supabase_project_ref' x "$TREE/scripts/lib-fleet-project.sh" 2>/dev/null)" = "$(o apply-sql.sh | sed -n 's/^PROJECT_REF="\([a-z0-9]*\)".*/\1/p')" ] && echo same || echo different)" "same"
    else
        skip "C4 no .env.local on this machine, so what the installer would read here was not compared with the baseline's agent"
    fi
fi

# ==============================================================================
# D. Other names: nothing of this deployment's is left, and the names follow
# ==============================================================================
PART=D; say "D. with other names"
# This deployment's own words: from the baseline when there is one, and from fleet.config.ts.
SHARED=" fleet gridpane dashboard http https www com org net dev app github gitlab waf refresh example "
# An ordinary word in your own names (a product called "Server Tools", a label under test.example) is also in the
# scripts for its own reasons. Name such words here and they are not looked for: FLEET_NAMES_SHARED_WORDS="server tools".
SHARED="$SHARED$(printf '%s' "${FLEET_NAMES_SHARED_WORDS:-}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' ' ') "
: > "$T/words"
add_words() { local w; for w in $(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' ' '); do [ "${#w}" -ge 4 ] || continue; case "$SHARED" in *" $w "*) ;; *) echo "$w" >> "$T/words" ;; esac; done; }
add_words "$P $N $(printf '%s\n' "$APP" | sed -n '4,5p' | tr '\n' ' ')"
[ "$HAVE_BASELINE" = 1 ] && add_words "$OP $ON $OURL $OLABEL $OREF"
sort -u "$T/words" -o "$T/words"
# Jail prefixes to look for as "<prefix>-". One that is a shared word (the example's "fleet") is left
# out: "fleet-" is in every script's own name.
JAILS=""
for j in "$J" "$OJ"; do [ -n "$j" ] || continue; case "$SHARED $JAILS " in *" $j "*) ;; *) JAILS="$JAILS $j" ;; esac; done
JAILS="${JAILS# }"
# hits <dir> <control prefix> <control jail prefix>: the files under <dir> that still carry one of the words.
hits() {
    local w j
    while IFS= read -r w; do
        case "$2" in *"$w"*) continue ;; esac
        grep -r -a -i -l -F -e "$w" "$1" 2>/dev/null
    done < "$T/words"
    for j in $JAILS; do [ "$j" = "$3" ] || grep -r -a -l -E "(^|[^A-Za-z0-9])$j-" "$1" 2>/dev/null; done
}
other_names() { # <tag> <prefix> <name> <jail prefix>
    local tag="$1" p="$2" n="$3" j="$4" cap="$T/cap-$1" brand up found want plant w
    SET_ENV=("FLEET_PREFIX=$p" "FLEET_NAME=$n" "FLEET_JAIL_PREFIX=$j" "FLEET_REPO_URL=https://example.com/fleet" "FLEET_WAF_REFRESH_LABEL=com.example.fleet-waf-refresh")
    run_cases "$NEW" "$cap" self self
    reader "${SET_ENV[@]}" -- "fleet_names_script '$NEW/scripts/fleet-fail2ban-apply.remote.sh'" > "$T/apply-$tag.sh" 2>/dev/null
    generate "$T/apply-$tag.sh" "$cap/generated"
    brand="$(printf '%s' "$p" | cut -c1 | tr 'a-z' 'A-Z')${p#?}"; up=$(printf '%s' "$j" | tr 'a-z' 'A-Z')
    yes "as $p / $n / $j: the scripts still send ($(calls "$cap") sends, $(count "$cap") files, $(bytes "$cap") bytes to read)" "$([ "$(calls "$cap")" -ge 30 ] && [ "$(count "$cap/generated")" -ge 6 ] && echo 1 || echo 0)" "$(calls "$cap") sends, $(count "$cap/generated") generated files"
    if { [ -s "$T/words" ] || [ -n "$JAILS" ]; } && [ "$p" != "$P" ]; then
        found="$(hits "$cap" "$p $n" "$j" | sort -u)"
        yes "as $p / $n / $j: none of this deployment's $(wc -l < "$T/words" | tr -d ' ') own words, and no \"${JAILS:+$(printf '%s' "$JAILS" | tr ' ' '|')-}\" name, in anything sent, installed or printed" "$([ -z "$found" ] && echo 1 || echo 0)" "$(printf '%s\n' "$found" | grep -c .) files, such as $(printf '%s\n' "$found" | head -3 | sed "s|$cap/||" | tr '\n' ' '). The words looked for: $(tr '\n' ' ' < "$T/words"). If one is an ordinary word the scripts use for their own reasons, run again with FLEET_NAMES_SHARED_WORDS=\"that word\""
        mkdir -p "$T/plant-$tag"; want=0
        # Plant a word the search does look for under these names: one that is part of the control names is skipped by it.
        plant=""; while IFS= read -r w; do case "$p $n" in *"$w"*) ;; *) plant="$w"; break ;; esac; done < "$T/words"
        if [ -n "$plant" ]; then want=$((want+1)); { cat "$cap/snapshot/call-1.stdin"; echo "echo $plant"; } > "$T/plant-$tag/a"; fi
        if [ -n "$JAILS" ]; then want=$((want+1)); { echo "x"; echo "rm /etc/fail2ban/filter.d/${JAILS%% *}-base.conf"; } > "$T/plant-$tag/b"; fi
        yes "control: what is looked for, planted in a copy, is found ($want of $want)" "$([ "$(hits "$T/plant-$tag" "$p $n" "$j" | sort -u | grep -c .)" = "$want" ] && echo 1 || echo 0)"
    else
        skip "as $p / $n / $j: fleet.config.ts has no words of its own to look for here (it uses these names, or only words every deployment shares)"
    fi
    yes "as $p / $n / $j: the installed names follow the setting" "$(
        [ -r "$cap/generated/etc/fail2ban/action.d/$p-cloudflare.conf" ] && [ -r "$cap/generated/etc/fail2ban/filter.d/$j-base-hard.conf" ] \
        && grep -q "/etc/logrotate.d/$p-7g-logs" "$cap/rotate-set/call-1.args" && grep -q "^# Managed by $n — 7G WAF log rotation\.$" "$(biggest "$cap/rotate-set")" \
        && grep -q "/etc/fail2ban/jail.d/$p-allowlist.local" "$cap/allow-apply/call-1.args" && grep -q "# Managed by $n — operator allowlist\." "$cap/allow-apply/call-1.stdin" \
        && grep -q "$brand operator allowlist" "$cap/allow-web/call-1.stdin" \
        && grep -q "/jail.d/$p-cloudflare.local" "$(biggest "$cap/agent-update")" && grep -qF "$up = re.compile(r\"^$j-[" "$(biggest "$cap/agent-update")" \
        && grep -qF "/pre/$p-port-window.sh" "$cap/certbot-apply/call-1.stdin" && grep -qF "/var/lib/$p/certbot-port-window" "$(biggest "$cap/certbot-apply")" \
        && grep -qF "/root/$p-site-hold/" "$cap/hold-freeze/call-1.stdin" \
        && grep -q "Documentation=https://example.com/fleet" "$cap/signin-audit/call-1.stdin" \
        && grep -qF "grep -c '^$j-'" "$cap/snapshot/call-1.stdin" && echo 1 || echo 0)"
    yes "as $p / $n / $j: no placeholder reaches a server" "$(grep -r -a -l -E '__FLEET_[A-Z_]+__' "$cap" 2>/dev/null | grep -q . && echo 0 || echo 1)" "$(grep -r -a -l -E '__FLEET_[A-Z_]+__' "$cap" 2>/dev/null | head -3 | sed "s|$cap/||" | tr '\n' ' ')"
}
other_names fleet fleet "Fleet" fleet
other_names acme acme "Acme Ops" zq

echo
if [ "$fail" != 0 ]; then echo "$ran checks, $fail FAILED${notrun:+, $notrun not run}"; exit 1; fi
if [ "$notrun" != 0 ]; then echo "$ran checks, 0 failed, $notrun NOT RUN (read the NOT RUN lines above: this is not the whole proof)"; exit 0; fi
echo "$ran checks, 0 failed"
