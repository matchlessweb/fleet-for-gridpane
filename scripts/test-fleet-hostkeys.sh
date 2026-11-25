#!/bin/bash
# ==============================================================================
# Host keys: every script that connects checks a server is the one it met first
# ==============================================================================
#   bash scripts/test-fleet-hostkeys.sh              the checks
#   bash scripts/test-fleet-hostkeys.sh --controls   break a copy of the scripts on purpose, one
#                                                    way at a time, and check this test notices
#
# NOTHING HERE REACHES A SERVER. The scripts under test are copied to a temp
# folder and run there with a stand-in `ssh` first on the PATH: it writes down
# what it was handed and answers "ok", or prints what the real ssh prints when a
# host key has changed. The server list is two made-up servers at documentation
# addresses. HOME is a temp folder, so the real ~/.config/fleet and ~/.ssh are
# never read or written. curl, dig, scp, rsync, security, ssh-add and sleep are
# stand-ins too.
#
# A. The one definition (lib-fleet-hostkeys.sh): which file, the two ssh
#    options, the folder and file it makes and their permissions, what it
#    refuses, and what counts as a refused host key.
# B. Every script that connects: each ssh call carries the two options and names
#    the temp known-hosts file, and nothing touches ~/.ssh.
# C. A changed host key: the script says so, prints the exact ssh-keygen command
#    for that address and that file, and does not try the server a second time.
#    Control: a timeout, on the same stand-in, is tried twice.
# D. No script names the options or the file itself, and no script calls ssh,
#    scp or rsync without them.
#
# FLEET_HOSTKEYS_TREE points the checks at another copy of the repository (the
# controls use it).
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TREE="${FLEET_HOSTKEYS_TREE:-$REPO}"
CONTROLS=0; QUIET=0
for a in "$@"; do
    case "$a" in
        --controls) CONTROLS=1 ;; --quiet) QUIET=1 ;;
        -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $a (only --controls)"; exit 2 ;;
    esac
done
command -v python3 >/dev/null || { echo "ABORT: python3 is needed"; exit 1; }

T=$(mktemp -d) || exit 1
trap 'rm -rf "${T:?}"' EXIT

# ------------------------------------------------------------------------------
# --controls: break a copy one way at a time; each break must fail a check
# ------------------------------------------------------------------------------
if [ "$CONTROLS" = 1 ]; then
    n=0; caught=0
    try() { # label, file, perl expression
        local copy out rc; n=$((n+1)); copy="$T/broken-$n"
        mkdir -p "$copy/scripts"
        for f in "$TREE"/scripts/*; do case "$f" in *.local) ;; *) [ -f "$f" ] && cp "$f" "$copy/scripts/" ;; esac; done
        perl -0pi -e "$3" "$copy/scripts/$2"
        if cmp -s "$copy/scripts/$2" "$TREE/scripts/$2"; then echo "  MISSED  $1  (the break did not change $2: fix this control)"; rm -rf "$copy"; return; fi
        if ! /bin/bash -n "$copy/scripts/$2" 2>/dev/null; then echo "  MISSED  $1  (the broken copy is not a program: fix this control)"; rm -rf "$copy"; return; fi
        out=$(FLEET_HOSTKEYS_TREE="$copy" bash "$0" --quiet 2>&1); rc=$?
        if [ "$rc" = 1 ] && printf '%s\n' "$out" | grep -q '^  FAIL ' && printf '%s\n' "$out" | tail -1 | grep -qE '^[0-9]+ checks, [0-9]+ FAILED$'; then
            caught=$((caught+1)); echo "  caught  $1  ($(printf '%s\n' "$out" | grep -c '^  FAIL ') failing)"
        else echo "  MISSED  $1  (exit $rc)"; printf '%s\n' "$out" | tail -3 | sed 's/^/          /'; fi
        rm -rf "$copy"
    }
    echo "Breaking a copy of the scripts on purpose. Each line is one full run of this test."
    try "the shared options stop checking host keys"                  lib-fleet-hostkeys.sh 's/"-o StrictHostKeyChecking=accept-new -o/"-o StrictHostKeyChecking=no -o/'
    try "the shared options ask before a first connection instead"    lib-fleet-hostkeys.sh 's/"-o StrictHostKeyChecking=accept-new -o/"-o StrictHostKeyChecking=ask -o/'
    try "the shared options keep keys in ~/.ssh/known_hosts"          lib-fleet-hostkeys.sh 's/-o UserKnownHostsFile=\$f"/-o UserKnownHostsFile=\$HOME\/.ssh\/known_hosts"/'
    try "the shared options name no file at all"                      lib-fleet-hostkeys.sh 's/ -o UserKnownHostsFile=\$f"/"/'
    try "FLEET_KNOWN_HOSTS is ignored"                                lib-fleet-hostkeys.sh 's/\$\{FLEET_KNOWN_HOSTS:-\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/fleet\/known_hosts\}/\${XDG_CONFIG_HOME:-\$HOME\/.config}\/fleet\/known_hosts/'
    try "XDG_CONFIG_HOME is ignored"                                  lib-fleet-hostkeys.sh 's/\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/fleet\/known_hosts/\$HOME\/.config\/fleet\/known_hosts/'
    try "the default file has another name"                           lib-fleet-hostkeys.sh 's/\/fleet\/known_hosts\}"/\/fleet\/hosts}"/'
    try "the folder is made for everyone to read"                     lib-fleet-hostkeys.sh 's/\( umask 077; mkdir -p "\$dir" \)/( umask 022; mkdir -p "\$dir" )/'
    try "the file is made for everyone to read"                       lib-fleet-hostkeys.sh 's/\( umask 077; : > "\$f" \)/( umask 022; : > "\$f" )/'
    try "a file that is already there is emptied"                     lib-fleet-hostkeys.sh 's/if \[ ! -e "\$f" \]; then/if true; then/'
    try "a path with a space in it is taken"                          lib-fleet-hostkeys.sh 's/\*\[!A-Za-z0-9\._\/\@\+,:-\]\*\)/__never__)/'
    try "a path that is not a full path is taken"                     lib-fleet-hostkeys.sh 's/\n        \*\) echo "ABORT: the known-hosts file must be a full path[^\n]*\n[^\n]*\n           return 1 ;;/\n        *) ;;/'
    try "a changed host key is tried a second time"                   lib-fleet-ssh.sh 's/^    fleet_hostkey_is_refusal "\$errf" && return 1   # host-keys\n//m; s/permission denied\|host key verification failed\|/permission denied|/'
    try "the banner alone no longer stops a second try"               lib-fleet-ssh.sh 's/^    fleet_hostkey_is_refusal "\$errf" && return 1   # host-keys\n//m'
    try "the test for a refusal misses the plain last line"           lib-fleet-hostkeys.sh 's/remote host identification has changed\|host key verification failed/remote host identification has changed/'
    try "the test for a refusal misses the banner"                    lib-fleet-hostkeys.sh 's/remote host identification has changed\|host key verification failed/host key verification failed/'
    try "every ssh failure is called a changed host key"              lib-fleet-hostkeys.sh 's/    grep -qiE .remote host identification has changed\|host key verification failed. "\$1"/    return 0/'
    try "the runner no longer says a host key changed"                lib-fleet-ssh.sh 's/^    fleet_hostkey_refusal "\$errf" "\$ip" \|\| true   # host-keys\n//m'
    try "the printed command names ~/.ssh/known_hosts"                lib-fleet-hostkeys.sh 's/ssh-keygen -R \$ip -f \$f"/ssh-keygen -R \$ip -f \$HOME\/.ssh\/known_hosts"/'
    try "the printed command leaves the address out"                  lib-fleet-hostkeys.sh 's/ssh-keygen -R \$ip -f \$f"/ssh-keygen -R -f \$f"/'
    try "the message no longer says a rebuilt server is expected"     lib-fleet-hostkeys.sh 's/^    echo "   This is expected after a server was rebuilt[^\n]*\n//m'
    try "the message no longer says to stop and look otherwise"       lib-fleet-hostkeys.sh 's/^    echo "   If the server was not rebuilt, stop and look[^\n]*\n//m'
    try "the message no longer says nothing was run or retried"       lib-fleet-hostkeys.sh 's/^    echo "   Nothing was run on that server[^\n]*\n//m'
    try "the site copy does not name a changed host key"              fleet-site-final-copy.sh 's/^    if fleet_hostkey_refusal "\$SSHERR" "\$2"; then exit 1; fi\n//m'
    try "the site copy carries on after a changed host key"           fleet-site-final-copy.sh 's/^    if fleet_hostkey_refusal "\$SSHERR" "\$2"; then exit 1; fi$/    fleet_hostkey_refusal "\$SSHERR" "\$2"/m'
    try "one script accepts any host key again"                       fleet-site-hold.sh 's/^SSH_OPTS="\$FLEET_HOSTKEY_OPTS /SSH_OPTS="-o StrictHostKeyChecking=no /m'
    try "one script names a known-hosts file of its own"              install-7g-logrotate.sh 's/^SSH_OPTS="\$FLEET_HOSTKEY_OPTS /SSH_OPTS="\$FLEET_HOSTKEY_OPTS -o UserKnownHostsFile=\/dev\/null /m'
    try "one script builds the options a second time, its own way"    fleet-fail2ban.sh 's/^(SSH_OPTS=.*)$/$1\nSSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"/m'
    try "the site copy leaves the options out of one connection"      fleet-site-final-copy.sh 's/^new\(\) \{ ssh \$SSHO /new() { ssh /m'
    try "a script gains an ssh call with no options"                  fleet-server-snapshot.sh 's/^(SSH_OPTS=.*)$/$1\nssh "root\@203.0.113.21" true < \/dev\/null/m'
    try "a script gains an rsync that goes round the rule"            install-certbot-port-hook.sh 's/\z/\nif false; then rsync -a -e ssh \/tmp\/x "root\@203.0.113.21:\/tmp\/x"; fi\n/'
    try "a script reads the options without the shared line"          provision-agent-tokens.sh 's/^\. "\$\(dirname "\$0"\)\/lib-fleet-hostkeys\.sh" \|\| exit 1; FLEET_HOSTKEY_OPTS="\$\(fleet_hostkey_opts\)" \|\| exit 1[^\n]*\n/FLEET_HOSTKEY_OPTS="\$(fleet_hostkey_opts 2>\/dev\/null)"\n/m'
    echo; echo "$n broken copies: $caught caught, $((n - caught)) missed"
    [ "$caught" = "$n" ]; exit $?
fi

fail=0; ran=0; PART=""
ok()   { ran=$((ran+1)); [ "$QUIET" = 1 ] || echo "  ok   $PART  $1"; }
bad()  { ran=$((ran+1)); fail=$((fail+1)); echo "  FAIL $PART  $1${2:+  ($2)}"; }
yes()  { if [ "$2" = 1 ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }       # label, 1|0, detail
same() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got \"$2\", wanted \"$3\""; fi; }
say()  { [ "$QUIET" = 1 ] || echo "$@"; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

# ------------------------------------------------------------------------------
# The stand-ins and the fixtures
# ------------------------------------------------------------------------------
mkdir -p "$T/bin" "$T/home" "$T/tmp" "$T/fx/audit" "$T/fx/snap" "$T/out"
cat > "$T/bin/ssh" <<'STANDIN_SSH'
#!/bin/bash
# Stand-in for ssh: writes down what it was given and reaches nothing.
n=$(( $(cat "$CAP/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CAP/count"
printf '%s\n' "$@" > "$CAP/call-$n.args"
cat > "$CAP/call-$n.stdin"
if [ -n "${FAKE_SSH_STDERR:-}" ]; then cat "$FAKE_SSH_STDERR" >&2; exit 255; fi
echo "ok"
STANDIN_SSH
for c in scp rsync sftp security supabase ssh-add sleep dig; do printf '#!/bin/bash\nexit 0\n' > "$T/bin/$c"; done
printf '#!/bin/bash\necho "stand-in-token-value"\n' > "$T/bin/tokencmd"
# curl: Cloudflare's public address ranges for the one script that asks, the made-up server list for the rest.
cat > "$T/bin/curl" <<'STANDIN_CURL'
#!/bin/bash
cat > /dev/null
case "$*" in
    *client/v4/ips*) printf '%s\n' '{"result":{"ipv4_cidrs":["192.0.2.0/24"],"ipv6_cidrs":["2001:db8::/32"]}}' ;;
    *) printf '%s\n' '[{"id":101,"ip":"203.0.113.21","label":"web1"},{"id":102,"ip":"203.0.113.22","label":"web2"}]' '200' ;;
esac
STANDIN_CURL
chmod +x "$T/bin"/*
mkdir -p "$T/home/.config/fleet"
printf 'tokencmd cloudflare-{name}.token\n' > "$T/home/.config/fleet/cloudflare-token-command"; chmod 600 "$T/home/.config/fleet/cloudflare-token-command"
printf '203.0.113.21|101|web1|golden\n203.0.113.22|102|web2\n' > "$T/fx/servers"
ZONE="0a1b2c0a1b2c0a1b2c0a1b2c0a1b2c0a"
printf '{"example.com":{"zone_id":"%s","reach":{"reach":"direct"}}}\n' "$ZONE" > "$T/fx/report.json"
printf '{}\n' > "$T/fx/snap/manifest.json"; printf 'taken_utc=2026-01-15T06:20:00Z\n' > "$T/fx/snap/facts.txt"
printf 'NEXT_PUBLIC_SUPABASE_URL=https://db.example.com\nNEXT_PUBLIC_SUPABASE_ANON_KEY=stand-in-public-key-000000000000\nSUPABASE_SERVICE_ROLE_KEY=stand-in-service-key-00000000000\n' > "$T/fx/env"
# What the real ssh prints when the key saved for an address is not the one the server answers with.
cat > "$T/fx/err-changed" <<'ERR_CHANGED'
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
Someone could be eavesdropping on you right now (man-in-the-middle attack)!
It is also possible that a host key has just been changed.
The fingerprint for the ED25519 key sent by the remote host is
SHA256:made-up-fingerprint-for-this-test.
Please contact your system administrator.
Offending ED25519 key in /made/up/known_hosts:3
Host key for 203.0.113.21 has changed and you have requested strict checking.
Host key verification failed.
ERR_CHANGED
printf 'Host key verification failed.\n' > "$T/fx/err-plain"
printf '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nssh: connect to host 203.0.113.21 port 22: Connection timed out\n' > "$T/fx/err-banner-then-timeout"
printf 'ssh: connect to host 203.0.113.21 port 22: Operation timed out\n' > "$T/fx/err-timeout"
printf 'root@203.0.113.21: Permission denied (publickey).\n' > "$T/fx/err-denied"
: > "$T/fx/err-empty"
RUNPATH="$T/bin:$(dirname "$(command -v python3)"):/usr/bin:/bin:/usr/sbin:/sbin"

# The scripts under test, copied so nothing they write lands in the repository.
# A server list kept beside them (*.local) is left behind.
NEW="$T/new"; mkdir -p "$NEW/scripts"
for f in "$TREE"/scripts/*; do case "$f" in *.local) ;; *) [ -f "$f" ] && cp "$f" "$NEW/scripts/" ;; esac; done
LIB="$NEW/scripts/lib-fleet-hostkeys.sh"
[ -r "$LIB" ] || { echo "ABORT: $TREE/scripts/lib-fleet-hostkeys.sh is not there"; exit 1; }
KH="$T/home/.config/fleet/known_hosts"            # where the scripts must keep host keys in these runs
OPTS_WANT="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="

# lib <VAR=value>... -- <bash text>: source the one definition in an empty environment and run the text.
lib() {
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    # Run from the temp folder: a broken copy that takes a path that is not a full path then makes it there, not in the repo.
    ( cd "$T" && env -i PATH="$RUNPATH" ${envs[@]+"${envs[@]}"} /bin/bash -c '. "$1" || exit 9; '"$1" lib "$LIB" 2>&1 )
}
# sender <case> <stderr file or -> <script> [args]: run one script with the stand-ins, keep what it sent and said.
NAMES=("FLEET_PREFIX=acme" "FLEET_JAIL_PREFIX=zq" "FLEET_NAME=Acme Ops" "FLEET_REPO_URL=https://example.com/fleet" "FLEET_WAF_REFRESH_LABEL=com.example.fleet-waf-refresh" "FLEET_SUPABASE_URL=https://db.example.com" "FLEET_SUPABASE_ANON_KEY=stand-in-public-key-000000000000")
MORE_ENV=("FLEET_HOSTKEYS_TEST=1")                # one more setting for the next runs
sender() {
    local cap="$T/cap/$1" err="$2" script="$3"; shift 3
    rm -rf "$cap"; mkdir -p "$cap"
    [ "$err" != - ] || err=""
    ( cd "$NEW" && env -i PATH="$RUNPATH" HOME="$T/home" TMPDIR="$T/tmp" CAP="$cap" FLEET_SERVERS_FILE="$T/fx/servers" \
        F2B_AUDIT_OUT="$T/fx/audit" WAF_REPORT="$T/fx/report.json" FLEET_ENV_FILE="$T/fx/env" FLEET_OUTPUT_DIR="$T/out" \
        FAKE_SSH_STDERR="$err" "${NAMES[@]}" "${MORE_ENV[@]}" /bin/bash "scripts/$script" "$@" </dev/null >"$cap/stdout" 2>&1 )
    echo $? > "$cap/rc"
}
calls() { cat "$T/cap/$1/count" 2>/dev/null || echo 0; }
# Every script that connects, in a form that only looks. <name>|<servers it contacts>|<script and arguments>
CASES="agent-audit|2|fix-telemetry-crontabs.sh
f2b-dry-run|1|fleet-fail2ban-apply.sh web1
f2b-proof|1|fleet-fail2ban-token-proof.sh web1 example.com $ZONE
f2b-audit|1|fleet-fail2ban.sh web1
restore|1|fleet-server-restore.sh web1 --snapshot $T/fx/snap
snapshot|1|fleet-server-snapshot.sh web1
final-copy|1|fleet-site-final-copy.sh shop.example.com --from web1 --to web2 --files-since 2026-01-15_06:20:00 rehearse
hold-status|1|fleet-site-hold.sh shop.example.com web1 status
rotate-audit|2|install-7g-logrotate.sh
certbot-audit|2|install-certbot-port-hook.sh
signin-audit|2|install-fleet-sso-agent.sh
allow-audit|2|install-operator-allowlist.sh
lock-audit|2|lock-web-ports-cloudflare.sh
token-audit|2|provision-agent-tokens.sh"
NCASES=$(printf '%s\n' "$CASES" | grep -c .)
# run_all <tag> <stderr file or ->: every case once. The time in --files-since has a space; it is put back here.
run_all() {
    local tag="$1" err="$2" name n cmd script
    # The audit writes its answer where the dry run reads one, so the fixture is made fresh for each pass.
    printf 'site=shop.example.com wp=yes\naudit_complete=yes\n' > "$T/fx/audit/web1.txt"
    while IFS='|' read -r name n cmd; do
        set -- $cmd; script="$1"; shift
        if [ "$name" = final-copy ]; then set -- shop.example.com --from web1 --to web2 --files-since "2026-01-15 06:20:00" rehearse; fi
        sender "$tag-$name" "$err" "$script" "$@"
    done <<CASES_END
$CASES
CASES_END
}

# ==============================================================================
# A. The one definition
# ==============================================================================
PART=A; say "A. the one definition (lib-fleet-hostkeys.sh)"
same "with nothing set, the file is ~/.config/fleet/known_hosts" "$(lib HOME=/made/up/home -- 'fleet_known_hosts_file')" "/made/up/home/.config/fleet/known_hosts"
same "XDG_CONFIG_HOME moves it" "$(lib HOME=/made/up/home XDG_CONFIG_HOME=/made/up/xdg -- 'fleet_known_hosts_file')" "/made/up/xdg/fleet/known_hosts"
same "FLEET_KNOWN_HOSTS wins over both" "$(lib HOME=/made/up/home XDG_CONFIG_HOME=/made/up/xdg FLEET_KNOWN_HOSTS=/made/up/kh -- 'fleet_known_hosts_file')" "/made/up/kh"
H1="$T/a-home"; mkdir -p "$H1"
same "the options are accept-new and that one file, and nothing else" "$(lib "HOME=$H1" -- 'fleet_hostkey_opts')" "$OPTS_WANT$H1/.config/fleet/known_hosts"
same "the folder it made is yours alone (700), and so is the folder above it" "$(mode_of "$H1/.config/fleet") $(mode_of "$H1/.config")" "700 700"
same "the file it made is yours alone (600), and empty" "$(mode_of "$H1/.config/fleet/known_hosts") $(wc -c < "$H1/.config/fleet/known_hosts" | tr -d ' ')" "600 0"
printf '203.0.113.21 ssh-ed25519 made-up-key\n' > "$H1/.config/fleet/known_hosts"; chmod 644 "$H1/.config/fleet/known_hosts"
lib "HOME=$H1" -- 'fleet_hostkey_opts' > /dev/null
same "a file that is already there is left as it is: its line and its permissions" "$(cat "$H1/.config/fleet/known_hosts") $(mode_of "$H1/.config/fleet/known_hosts")" "203.0.113.21 ssh-ed25519 made-up-key 644"
H2="$T/a-home2"; mkdir -p "$H2/kept"; chmod 755 "$H2/kept"
same "a folder that is already there keeps its permissions; the file made in it is 600" "$(lib "HOME=$H2" "FLEET_KNOWN_HOSTS=$H2/kept/hosts" -- 'fleet_hostkey_opts' > /dev/null; echo "$(mode_of "$H2/kept") $(mode_of "$H2/kept/hosts")")" "755 600"
same "nothing was made under ~/.ssh" "$(ls -d "$H1/.ssh" "$H2/.ssh" 2>/dev/null | wc -l | tr -d ' ')" "0"
refused() { # label, the file named. Must return 1, say ABORT, print no option and make nothing.
    local out rc; out="$(lib "HOME=$T/a-refuse" "FLEET_KNOWN_HOSTS=$2" -- 'o="$(fleet_hostkey_opts)"; rc=$?; echo "opts=[$o]"; exit $rc')"; rc=$?
    yes "$1" "$([ "$rc" = 1 ] && printf '%s' "$out" | grep -q '^ABORT' && printf '%s' "$out" | grep -qx 'opts=\[\]' && [ ! -e "$T/a-refuse" ] && echo 1 || echo 0)" "exit $rc: $(printf '%s' "$out" | tail -1 | cut -c1-80)"
}
refused "a path with a space in it is refused, and nothing is made"          "$T/a-refuse/with space/known_hosts"
refused "a path that is not a full path is refused"                          "a-refuse/known_hosts"
refused "a path with a % in it is refused (ssh would read it as a pattern)"  "$T/a-refuse/%h/known_hosts"
refused "a path with a * in it is refused"                                   "$T/a-refuse/*/known_hosts"
mkdir -p "$T/a-ro"; : > "$T/a-ro/kh"; chmod 400 "$T/a-ro/kh"
out="$(lib "HOME=$T/a-ro" "FLEET_KNOWN_HOSTS=$T/a-ro/kh" -- 'fleet_hostkey_opts')"; rc=$?
yes "a file that cannot be written is refused: new keys could not be saved" "$([ "$rc" = 1 ] && printf '%s' "$out" | grep -q '^ABORT' && echo 1 || echo 0)" "exit $rc"
is_refusal() { lib HOME=/made/up/home -- "fleet_hostkey_is_refusal '$T/fx/$1' && echo yes || echo no"; }
same "what ssh prints for a changed key counts as a refusal" "$(is_refusal err-changed)" "yes"
same "its last line alone counts too" "$(is_refusal err-plain)" "yes"
same "the banner alone counts too" "$(is_refusal err-banner-then-timeout)" "yes"
same "control: a timeout is not a refusal" "$(is_refusal err-timeout)" "no"
same "control: a refused sign-in is not a refused host key" "$(is_refusal err-denied)" "no"
same "control: no message is not a refusal" "$(is_refusal err-empty)" "no"
transient() { env -i PATH="$RUNPATH" HOME=/made/up/home /bin/bash -c '. "$1" || exit 9; fleet_ssh_is_transient "$2" "$3" && echo retry || echo stop' t "$NEW/scripts/lib-fleet-ssh.sh" "$T/fx/$1" "$2" 2>&1; }
same "a changed host key is never tried again" "$(transient err-changed 255)" "stop"
same "nor is its last line alone" "$(transient err-plain 255)" "stop"
same "nor is the banner followed by a timeout line" "$(transient err-banner-then-timeout 255)" "stop"
same "control: a timeout is tried again" "$(transient err-timeout 255)" "retry"
EXPLAIN="$(lib "HOME=$T/home" -- "fleet_hostkey_refusal '$T/fx/err-changed' 203.0.113.21; echo rc=\$?")"
yes "the message names the address and says ssh refused" "$(printf '%s\n' "$EXPLAIN" | grep -q 'STOP: ssh refused to connect to 203.0.113.21\.' && echo 1 || echo 0)"
yes "it prints the exact command to forget the old key, for that address and that file" "$(printf '%s\n' "$EXPLAIN" | grep -qxF "       ssh-keygen -R 203.0.113.21 -f $KH" && echo 1 || echo 0)" "$(printf '%s\n' "$EXPLAIN" | grep ssh-keygen)"
yes "it says this is expected after a server was rebuilt at the same address" "$(printf '%s\n' "$EXPLAIN" | grep -q 'expected after a server was rebuilt at the same address' && echo 1 || echo 0)"
yes "it says to stop and look otherwise" "$(printf '%s\n' "$EXPLAIN" | grep -q 'If the server was not rebuilt, stop and look' && echo 1 || echo 0)"
yes "it says nothing was run and nothing was tried again" "$(printf '%s\n' "$EXPLAIN" | grep -q 'Nothing was run on that server, and it was not tried again' && echo 1 || echo 0)"
same "control: for a timeout it says nothing at all" "$(lib "HOME=$T/home" -- "fleet_hostkey_refusal '$T/fx/err-timeout' 203.0.113.21; echo rc=\$?")" "rc=1"
same "with FLEET_KNOWN_HOSTS set, the command names that file" "$(lib "HOME=$T/home" "FLEET_KNOWN_HOSTS=$T/other/kh" -- 'fleet_hostkey_explain 203.0.113.22' | grep ssh-keygen | sed 's/^ *//')" "ssh-keygen -R 203.0.113.22 -f $T/other/kh"

# ==============================================================================
# B. Every script that connects carries the two options
# ==============================================================================
PART=B; say "B. every script that connects"
rm -f "$KH"
run_all ok -
nsent=0; quiet=""; wrong=""; loose=""
while IFS='|' read -r name n cmd; do
    c=$(calls "ok-$name"); [ "$c" -ge 1 ] || { quiet="$quiet $name"; continue; }
    i=1; while [ "$i" -le "$c" ]; do
        nsent=$((nsent+1)); f="$T/cap/ok-$name/call-$i.args"
        [ "$(sed -n '1,4p' "$f" | tr '\n' ' ')" = "-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH " ] || wrong="$wrong $name#$i"
        [ "$(grep -c 'StrictHostKeyChecking\|UserKnownHostsFile' "$f")" = 2 ] || loose="$loose $name#$i"
        i=$((i+1))
    done
done <<CASES_B
$CASES
CASES_B
yes "all $NCASES scripts sent something, so none was looked at blind ($nsent ssh calls)" "$([ -z "$quiet" ] && [ "$NCASES" -ge 14 ] && [ "$nsent" -ge "$NCASES" ] && echo 1 || echo 0)" "sent nothing:$quiet"
yes "every one of those $nsent calls starts with accept-new and Fleet's own known-hosts file" "$([ -z "$wrong" ] && echo 1 || echo 0)" "not so:$wrong"
yes "and names each of the two options once, so nothing later on the line can undo them" "$([ -z "$loose" ] && echo 1 || echo 0)" "not so:$loose"
same "the known-hosts file was made, for you alone" "$(mode_of "$KH")" "600"
same "nothing was made under ~/.ssh, and no ~/.ssh/known_hosts was named in any call" "$(ls -d "$T/home/.ssh" 2>/dev/null | wc -l | tr -d ' ') $(cat "$T/cap"/ok-*/call-*.args | grep -c '\.ssh/known_hosts')" "0 0"
printf 'x\n' > "$T/b-control.args"
yes "control: a call with no options would not have passed" "$([ "$(sed -n '1,4p' "$T/b-control.args" | tr '\n' ' ')" = "-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH " ] && echo 0 || echo 1)"
MORE_ENV=("FLEET_KNOWN_HOSTS=$T/has space/kh"); sender bad-path - fleet-fail2ban.sh web1; MORE_ENV=("FLEET_HOSTKEYS_TEST=1")
same "a script given a known-hosts path it cannot use stops before it connects" "$(cat "$T/cap/bad-path/rc") $(grep -c '^ABORT: the known-hosts file' "$T/cap/bad-path/stdout") $(calls bad-path)" "1 1 0"
MORE_ENV=("FLEET_KNOWN_HOSTS=$T/elsewhere/kh"); sender other-file - fleet-fail2ban.sh web1; MORE_ENV=("FLEET_HOSTKEYS_TEST=1")
same "a script follows FLEET_KNOWN_HOSTS: the call names that file, and it was made" "$(sed -n '4p' "$T/cap/other-file/call-1.args" 2>/dev/null) $(mode_of "$T/elsewhere/kh")" "UserKnownHostsFile=$T/elsewhere/kh 600"

# ==============================================================================
# C. A changed host key
# ==============================================================================
PART=C; say "C. a server answers with another host key"
run_all changed "$T/fx/err-changed"
run_all timeout "$T/fx/err-timeout"
retried=""; silent=""; nocmd=""; norebuilt=""; nolook=""; nc=0; wrongaddr=""
while IFS='|' read -r name n cmd; do
    nc=$((nc+1)); d="$T/cap/changed-$name"
    [ "$(calls "changed-$name")" = "$n" ] || retried="$retried $name($(calls "changed-$name"),$n)"
    grep -q 'STOP: ssh refused to connect to 203\.0\.113\.21\. The host key it answered with is not the one saved' "$d/stdout" || silent="$silent $name"
    grep -qxF "       ssh-keygen -R 203.0.113.21 -f $KH" "$d/stdout" || nocmd="$nocmd $name"
    grep -q 'expected after a server was rebuilt at the same address' "$d/stdout" || norebuilt="$norebuilt $name"
    grep -q 'If the server was not rebuilt, stop and look' "$d/stdout" || nolook="$nolook $name"
    # A script that goes on to the second server names that one too, with its own address.
    if [ "$n" = 2 ]; then grep -qxF "       ssh-keygen -R 203.0.113.22 -f $KH" "$d/stdout" || wrongaddr="$wrongaddr $name"; fi
done <<CASES_C
$CASES
CASES_C
yes "no script tries a server twice after a changed host key ($nc scripts; one call for each server it contacts)" "$([ -z "$retried" ] && [ "$nc" -ge 14 ] && echo 1 || echo 0)" "calls made, wanted:$retried"
yes "every script says in plain words that ssh refused and why" "$([ -z "$silent" ] && echo 1 || echo 0)" "silent:$silent"
yes "every script prints the exact ssh-keygen -R command, with the address and the file" "$([ -z "$nocmd" ] && echo 1 || echo 0)" "missing:$nocmd"
yes "a script that contacts two servers prints the command for each address" "$([ -z "$wrongaddr" ] && echo 1 || echo 0)" "missing:$wrongaddr"
yes "every script says this is expected after a rebuild at the same address" "$([ -z "$norebuilt" ] && echo 1 || echo 0)" "missing:$norebuilt"
yes "every script says to stop and look otherwise" "$([ -z "$nolook" ] && echo 1 || echo 0)" "missing:$nolook"
same "the site copy stops there: it exits 1 after its one call" "$(cat "$T/cap/changed-final-copy/rc") $(calls changed-final-copy)" "1 1"
same "and it does not go on to say the server did not answer: the host key is the last thing it says" "$(grep -c 'did not answer' "$T/cap/changed-final-copy/stdout") $(tail -1 "$T/cap/changed-final-copy/stdout" | grep -c 'answering at that address')" "0 1"
yes "the one-server scripts that stop on a failed read do stop (dry run, token proof, restore, hold)" "$([ "$(cat "$T/cap/changed-f2b-dry-run/rc")$(cat "$T/cap/changed-f2b-proof/rc")$(cat "$T/cap/changed-restore/rc")$(cat "$T/cap/changed-hold-status/rc")" = 1111 ] && echo 1 || echo 0)"
# Control: the same stand-in, failing with a timeout. The shared runner tries once more; nothing speaks of host keys.
twice=""; spoke=""; nt=0
while IFS='|' read -r name n cmd; do
    [ "$name" != final-copy ] || continue        # the site copy has no second try of its own: it stops
    nt=$((nt+1)); [ "$(calls "timeout-$name")" = "$((n * 2))" ] || twice="$twice $name($(calls "timeout-$name"),$((n * 2)))"
done <<CASES_T
$CASES
CASES_T
yes "control: after a timeout the same $nt scripts do try each server a second time" "$([ -z "$twice" ] && [ "$nt" -ge 13 ] && echo 1 || echo 0)" "calls made, wanted:$twice"
same "control: after a timeout no script speaks of host keys or prints ssh-keygen" "$(cat "$T/cap"/timeout-*/stdout | grep -c 'ssh-keygen\|host key')" "0"
same "control: with an ssh that answers, no script speaks of host keys either" "$(cat "$T/cap"/ok-*/stdout | grep -c 'ssh-keygen\|host key')" "0"

# ==============================================================================
# D. The options and the file are named in one place
# ==============================================================================
PART=D; say "D. one definition, and no way round it"
FIXED='. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with'
code() { grep -v '^[[:space:]]*#' "$1"; }                # a script without its comment lines
own=""; nread=0
for f in "$NEW"/scripts/*.sh; do
    case "$(basename "$f")" in *test*|lib-fleet-hostkeys.sh) continue ;; esac
    nread=$((nread+1)); code "$f" | grep -qE 'StrictHostKeyChecking|UserKnownHostsFile|known_hosts|FLEET_KNOWN_HOSTS' && own="$own $(basename "$f")"
done
yes "outside comments, the two options and the file's two names are in lib-fleet-hostkeys.sh and nowhere else ($nread other scripts read)" "$([ -z "$own" ] && [ "$nread" -ge 20 ] && [ "$(code "$LIB" | grep -cE 'StrictHostKeyChecking|UserKnownHostsFile|known_hosts|FLEET_KNOWN_HOSTS')" -ge 3 ] && echo 1 || echo 0)" "also in:$own"
nopt=0; shape=""
for f in "$NEW"/scripts/*.sh; do
    case "$(basename "$f")" in *test*) continue ;; esac
    grep -qE '^(SSH_OPTS|SSHO)=|FLEET_HOSTKEY_OPTS' "$f" || continue; nopt=$((nopt+1))
    [ "$(grep -cE '^(SSH_OPTS|SSHO)=' "$f")" = 1 ] && [ "$(grep -cE '^(SSH_OPTS|SSHO)="\$FLEET_HOSTKEY_OPTS -o ' "$f")" = 1 ] \
        && [ "$(grep -cxF "$FIXED" "$f")" = 1 ] && [ "$(grep -c 'FLEET_HOSTKEY_OPTS' "$f")" = 2 ] && [ "$(grep -c 'fleet_hostkey_opts' "$f")" = 1 ] || shape="$shape $(basename "$f")"
done
yes "the $nopt scripts that set ssh options all read them the same way: the one line, then the options first" "$([ -z "$shape" ] && [ "$nopt" -ge 14 ] && echo 1 || echo 0)" "differs:$shape"
# A command that connects: ssh, scp, sftp or rsync where a command starts. Each must carry the options variable.
CONNECTS='(^|[;|&({]|then|do|else|if|!)[[:space:]]*(ssh|scp|sftp|rsync)[[:space:]]'
bare=""; nconn=0
for f in "$NEW"/scripts/*.sh; do
    case "$(basename "$f")" in *test*) continue ;; esac
    nconn=$((nconn + $(code "$f" | grep -cE "$CONNECTS")))
    code "$f" | grep -E "$CONNECTS" | grep -qvE '\$(SSH_OPTS|SSHO)[[:space:]]' && bare="$bare $(basename "$f")"
done
yes "every ssh, scp, sftp or rsync command in the scripts carries the options ($nconn commands found)" "$([ -z "$bare" ] && [ "$nconn" -ge 3 ] && echo 1 || echo 0)" "without them:$bare"
printf '    rsync -a -e ssh /a "root@203.0.113.21:/a"\nold() { ssh "root@$OLD" "$@"; }\necho "the key is missing, so ssh will likely fail"\n' > "$T/planted.sh"
same "control: that search finds two planted commands and not a sentence that says ssh" "$(code "$T/planted.sh" | grep -E "$CONNECTS" | grep -cvE '\$(SSH_OPTS|SSHO)[[:space:]]')" "2"
same "the shared runner reads what a refusal is from the one definition: its three lines are there" "$(grep -c '# host-keys$' "$NEW/scripts/lib-fleet-ssh.sh")" "3"

echo
if [ "$fail" != 0 ]; then echo "$ran checks, $fail FAILED"; exit 1; fi
echo "$ran checks, 0 failed"
