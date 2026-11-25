#!/bin/bash
# ==============================================================================
# Two installers that look first: nothing changes without --apply
# ==============================================================================
#   bash scripts/test-installers-apply.sh              the checks
#   bash scripts/test-installers-apply.sh --controls   break a copy of the two scripts on purpose,
#                                                      one way at a time, and check this test notices
#
# For scripts/install-waf-refresh.sh (a daily job on this machine) and
# scripts/install-operator-allowlist.sh (a Fail2Ban file on every server).
#
# NOTHING HERE INSTALLS A JOB OR REACHES A SERVER. The two scripts are copied to
# a temp folder and run there with stand-ins first on the PATH: `launchctl` and
# `plutil` write down what they were asked and keep "is the job loaded" in a
# temp file; `ssh` writes down what it was handed and answers like a server
# with one address already allowed (or, for the web ports, two sources open); `git` answers the one question the job
# installer asks it. HOME is a temp folder and the server list is two made-up
# servers at documentation addresses.
#
# A. install-waf-refresh.sh: a plain run says what --apply would do and changes
#    nothing; --apply installs; --status and --remove do what they did.
# B. install-operator-allowlist.sh: an address on its own sends the read-only
#    audit and says what --apply would write, add and drop; --apply sends the
#    change. --clear, --ufw-web and --ufw-web-clear on their own only read the
#    server too, and say what the same command with --apply would do there.
#
# FLEET_INSTALLERS_TREE points the checks at another copy of the repository
# (the controls use it).
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TREE="${FLEET_INSTALLERS_TREE:-$REPO}"
CONTROLS=0; QUIET=0
for a in "$@"; do
    case "$a" in
        --controls) CONTROLS=1 ;; --quiet) QUIET=1 ;;
        -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $a (only --controls)"; exit 2 ;;
    esac
done

T=$(mktemp -d) || exit 1
T=$(cd "$T" && pwd -P)        # the real path: the job installer prints the folder it runs from that way
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
        out=$(FLEET_INSTALLERS_TREE="$copy" bash "$0" --quiet 2>&1); rc=$?
        if [ "$rc" = 1 ] && printf '%s\n' "$out" | grep -q '^  FAIL ' && printf '%s\n' "$out" | tail -1 | grep -qE '^[0-9]+ checks, [0-9]+ FAILED$'; then
            caught=$((caught+1)); echo "  caught  $1  ($(printf '%s\n' "$out" | grep -c '^  FAIL ') failing)"
        else echo "  MISSED  $1  (exit $rc)"; printf '%s\n' "$out" | tail -3 | sed 's/^/          /'; fi
        rm -rf "$copy"
    }
    echo "Breaking a copy of the two scripts on purpose. Each line is one full run of this test."
    W=install-waf-refresh.sh; A=install-operator-allowlist.sh
    try "the job installer installs on a plain run again"             "$W" 's/^if \[ "\$\{1:-\}" != "--apply" \]; then$/if false; then/m'
    try "a look writes the job's file"                                "$W" 's/^  echo "Looked only\. Nothing was changed\."$/  mkdir -p "\$(dirname "\$PLIST")"; plist_text > "\$PLIST"\n  echo "Looked only. Nothing was changed."/m'
    try "a look loads the job"                                        "$W" 's/^  echo "Looked only\. Nothing was changed\."$/  launchctl bootstrap "\$DOMAIN" "\$PLIST" 2>\/dev\/null || true\n  echo "Looked only. Nothing was changed."/m'
    try "a look takes the loaded job out"                             "$W" 's/^  echo "Looked only\. Nothing was changed\."$/  launchctl bootout "\$DOMAIN\/\$LABEL" 2>\/dev\/null || true\n  echo "Looked only. Nothing was changed."/m'
    try "a look makes the log folder"                                 "$W" 's/^  echo "Looked only\. Nothing was changed\."$/  mkdir -p "\$(dirname "\$LOG")"\n  echo "Looked only. Nothing was changed."/m'
    try "--apply is no longer an option"                              "$W" 's/^  ""\|--apply\) ;;$/  "") ;;/m'
    try "--apply writes the file but does not load the job"           "$W" 's/^launchctl bootstrap "\$DOMAIN" "\$PLIST"\n//m'
    try "a look does not say how to apply"                            "$W" 's/^    echo "  bash scripts\/install-waf-refresh\.sh --apply"\n//m'
    try "a look does not name the file it would write"                "$W" 's/^  if \[ ! -e "\$PLIST" \]; then echo "  write   \$PLIST   \(a new file\)"$/  if [ ! -e "\$PLIST" ]; then echo "  write   the job file"/m'
    try "a look calls a changed job file the same"                    "$W" 's/elif plist_text \| cmp -s - "\$PLIST"; then/elif true; then/'
    try "a look does not say what the job would run"                  "$W" 's/^  echo "  run     \/bin\/bash \$REPO\/scripts\/waf-refresh\.sh   once a day at 06:15"\n//m'
    try "a look in a worktree says to go ahead"                       "$W" 's/^  if \[ "\$WORKTREE" = 1 \]; then\n    echo "But --apply would stop here/  if false; then\n    echo "But --apply would stop here/m'
    try "--apply installs from a linked worktree"                     "$W" 's/^if \[ "\$WORKTREE" = 1 \]; then\n  echo "This is a linked worktree/if false; then\n  echo "This is a linked worktree/m'
    try "--remove leaves the job's file behind"                       "$W" 's/^    rm -f "\$PLIST"\n//m'
    try "an address on its own applies again"                         "$A" 's/if \[ "\$APPLY" = 1 \]; then MODE="apply"; else MODE="look"; fi/MODE="apply"/'
    try "a look sends the program that writes"                        "$A" 's/fleet_ssh "\$IP" "\$REMOTE_ALLOWLIST" audit "\$CONFIG_PATH" "" ;;/fleet_ssh "\$IP" "\$REMOTE_ALLOWLIST" apply "\$CONFIG_PATH" "\$IPS" ;;/'
    try "a look sends the audit with the addresses in it"             "$A" 's/fleet_ssh "\$IP" "\$REMOTE_ALLOWLIST" audit "\$CONFIG_PATH" "" ;;/fleet_ssh "\$IP" "\$REMOTE_ALLOWLIST" audit "\$CONFIG_PATH" "\$IPS" ;;/'
    try "--apply is taken for a look"                                 "$A" 's/if \[ "\$a" = "--apply" \]; then APPLY=1; else/if [ "\$a" = "--apply" ]; then APPLY=0; else/'
    try "--apply after the address is taken for the server's name"    "$A" 's/^APPLY=0; n=\$#\nwhile \[ "\$n" -gt 0 \]; do\n    a="\$1"; shift; n=\$\(\(n - 1\)\)\n    if \[ "\$a" = "--apply" \]; then APPLY=1; else set -- "\$\@" "\$a"; fi\ndone\n/APPLY=0; if [ "\${1:-}" = "--apply" ]; then APPLY=1; shift; fi\n/m'
    try "--apply with no address audits instead of stopping"          "$A" 's/\[ "\$APPLY" = 0 \] \|\| \{ echo "ABORT: --apply needs the address/true || { echo "ABORT: --apply needs the address/'
    try "a look skips the check for a shared carrier address"         "$A" 's/if \[ "\$MODE" = "apply" \] \|\| \[ "\$MODE" = "look" \] \|\| \[ "\$MODE" = "ufw-web" \]/if [ "\$MODE" = "apply" ] || [ "\$MODE" = "ufw-web" ]/'
    try "a look does not show the line it would write"                "$A" 's/^            echo "       ignoreip = 127\.0\.0\.0\/8 ::1 \$IPS"\n//m'
    try "a look hides the addresses it would drop"                    "$A" 's/^            echo "   no longer in it:     \$\{dropped:- none\}"\n//m'
    try "a look counts an address already there as new"               "$A" 's/if \[ "\$found" = 1 \]; then kept="\$kept \$ip"; else added="\$added \$ip"; fi/added="\$added \$ip"/'
    try "a look does not say how to apply"                            "$A" 's/^           echo "  bash \$0 --apply \$\(again\)" ;;$/           : ;;/m'
    try "the command it prints loses the server's name"               "$A" 's/; \[ -z "\$ONLY" \] \|\| printf . %s. "\$ONLY"; \}/; }/'
    try "a look does not say nothing was changed"                     "$A" 's/echo "Looked only\. Nothing was changed\. To make the change:"/echo "To make the change:"/'
    try "--clear on its own removes the file again"                   "$A" 's/if \[ "\$APPLY" = 1 \]; then MODE="clear"; else MODE="look-clear"; fi/MODE="clear"/'
    try "--apply --clear only looks"                                  "$A" 's/if \[ "\$APPLY" = 1 \]; then MODE="clear"; else MODE="look-clear"; fi/MODE="look-clear"/'
    try "a look at --clear does not say what it would remove"         "$A" 's/^            echo "   --apply would remove \$CONFIG_PATH and reload Fail2Ban\."\n//m'
    try "a look at --clear says a file is there when it is not"       "$A" 's/        elif echo "\$OUT" \| grep -q .dropin=present.; then\n            echo "   --apply would remove/        elif true; then\n            echo "   --apply would remove/'
    try "a look at --clear does not say nothing was changed"          "$A" 's/(look-clear\)\n\s+)echo "Looked only\. Nothing was changed\. To make the change:"/$1echo "To make the change:"/'
    try "a look at --clear does not print the command"                "$A" 's/^           echo "  bash \$0 --apply --clear\$\{ONLY:\+ \$ONLY\}" ;;$/           : ;;/m'
    try "--ufw-web on its own changes the firewall again"             "$A" 's/if \[ "\$APPLY" = 1 \]; then MODE="\$\{1#--\}"; else MODE="look-\$\{1#--\}"; fi/MODE="\${1#--}"/'
    try "--apply --ufw-web only looks"                                "$A" 's/if \[ "\$APPLY" = 1 \]; then MODE="\$\{1#--\}"; else MODE="look-\$\{1#--\}"; fi/MODE="look-\${1#--}"/'
    try "a look at the web ports sends the program that changes them" "$A" 's/fleet_ssh "\$IP" "\$REMOTE_UFW_LOOK" look ;;/fleet_ssh "\$IP" "\$REMOTE_UFW_WEB" "\${MODE#look-}" "\$IPS" ;;/'
    try "a look at the web ports sends the addresses to the server"   "$A" 's/fleet_ssh "\$IP" "\$REMOTE_UFW_LOOK" look ;;/fleet_ssh "\$IP" "\$REMOTE_UFW_LOOK" look "\$IPS" ;;/'
    try "the program that only reads the firewall adds a rule"        "$A" 's/^echo "ufw=read"\n/echo "ufw=read"\nufw prepend allow proto tcp from 192.0.2.1 to any port 80,443\n/m'
    try "the program that only reads the firewall deletes a rule"     "$A" 's/^echo "ufw=read"\n/echo "ufw=read"\nufw delete allow proto tcp from 192.0.2.1 to any port 80,443\n/m'
    try "the program that only reads the firewall goes out with no names" "$A" 's/^fleet_names_fill_var REMOTE_UFW_LOOK \|\| exit 1\n//m'
    try "a look at the web ports counts an open address as new"       "$A" 's/if \[ "\$found" = 1 \]; then there="\$there \$ip"; else absent="\$absent \$ip"; fi/absent="\$absent \$ip"/'
    try "a look at the web ports compares addresses as text"          "$A" 's/want=\$\(normalize_cidr "\$ip"\); found=0\n(\s+)for got in \$LIVE; do \[ "\$\(normalize_cidr "\$got"\)" = "\$want" \]/want="\$ip"; found=0\n$1for got in \$LIVE; do [ "\$got" = "\$want" ]/'
    try "a look at closing the web ports says it would open them"     "$A" 's/if \[ "\$MODE" = "look-ufw-web" \]; then\n(\s+)echo "   --apply would open/if true; then\n$1echo "   --apply would open/'
    try "a look at the web ports skips the shared carrier check"      "$A" 's/ \|\| \[ "\$MODE" = "look-ufw-web" \] \|\| \[ "\$MODE" = "look-ufw-web-clear" \]; then\n    for ip in/; then\n    for ip in/'
    try "a look at the web ports does not print the command"          "$A" 's/^           echo "  bash \$0 --apply --\$\{MODE#look-\} \$\(again\)" ;;$/           : ;;/m'
    try "a look at the web ports where UFW is missing says it is read" "$A" 's/        if echo "\$OUT" \| grep -q .ufw=absent.; then\n            echo "   --apply would change nothing here: UFW/        if false; then\n            echo "   --apply would change nothing here: UFW/'
    echo; echo "$n broken copies: $caught caught, $((n - caught)) missed"
    [ "$caught" = "$n" ]; exit $?
fi

fail=0; ran=0; PART=""
ok()   { ran=$((ran+1)); [ "$QUIET" = 1 ] || echo "  ok   $PART  $1"; }
bad()  { ran=$((ran+1)); fail=$((fail+1)); echo "  FAIL $PART  $1${2:+  ($2)}"; }
yes()  { if [ "$2" = 1 ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }       # label, 1|0, detail
same() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got \"$2\", wanted \"$3\""; fi; }
say()  { [ "$QUIET" = 1 ] || echo "$@"; }

# ------------------------------------------------------------------------------
# The stand-ins and the fixtures
# ------------------------------------------------------------------------------
mkdir -p "$T/bin" "$T/home" "$T/tmp" "$T/state" "$T/fx"
cat > "$T/bin/launchctl" <<'STANDIN_LAUNCHCTL'
#!/bin/bash
# Stand-in for launchctl: writes down what it was asked; "loaded" is a file.
printf '%s\n' "$*" >> "$STATE/launchctl.log"
case "$1" in
    print)     [ -e "$STATE/loaded" ] ;;
    bootstrap) [ -r "$3" ] || exit 5; : > "$STATE/loaded" ;;
    bootout)   [ -e "$STATE/loaded" ] || exit 3; rm -f "$STATE/loaded" ;;
    *)         exit 0 ;;
esac
STANDIN_LAUNCHCTL
printf '#!/bin/bash\nprintf "%%s\\n" "$*" >> "$STATE/plutil.log"\nexit 0\n' > "$T/bin/plutil"
cat > "$T/bin/git" <<'STANDIN_GIT'
#!/bin/bash
# Stand-in for git: the installer asks only whether it is in a linked worktree.
case "${FAKE_CHECKOUT:-none} $*" in
    "none "*)                               exit 128 ;;
    "main "*"rev-parse --git-dir")          echo ".git" ;;
    "main "*"rev-parse --git-common-dir")   echo ".git" ;;
    "worktree "*"rev-parse --git-dir")      echo "/made/up/main/.git/worktrees/topic" ;;
    "worktree "*"rev-parse --git-common-dir") echo "/made/up/main/.git" ;;
    *)                                      exit 1 ;;
esac
STANDIN_GIT
cat > "$T/bin/ssh" <<'STANDIN_SSH'
#!/bin/bash
# Stand-in for ssh: writes down what it was given and answers from a file.
n=$(( $(cat "$CAP/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CAP/count"
printf '%s\n' "$@" > "$CAP/call-$n.args"
cat > "$CAP/call-$n.stdin"
cat "$FAKE_SSH_REPLY"
STANDIN_SSH
for c in scp rsync ssh-add sleep security curl; do printf '#!/bin/bash\nexit 0\n' > "$T/bin/$c"; done
chmod +x "$T/bin"/*
printf '203.0.113.21|101|web1|golden\n203.0.113.22|102|web2\n' > "$T/fx/servers"
# A server with a file already there: loopback, one address this test asks for again, one it does not.
printf 'dropin=present\neffective: 127.0.0.0/8 ::1 198.51.100.7 203.0.113.50\n' > "$T/fx/reply-some"
printf 'dropin=absent\neffective: 127.0.0.0/8 ::1\n' > "$T/fx/reply-none"
printf 'fail2ban=absent\n' > "$T/fx/reply-nof2b"
# A server's firewall with ports 80 and 443 open to one address and one network.
printf 'ufw=read\nweb80443 203.0.113.50\nweb80443 198.51.100.0/24\n' > "$T/fx/reply-ufw"
printf 'ufw=absent\n' > "$T/fx/reply-noufw"
RUNPATH="$T/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NEW="$T/new"; mkdir -p "$NEW/scripts"
for f in "$TREE"/scripts/*; do case "$f" in *.local) ;; *) [ -f "$f" ] && cp "$f" "$NEW/scripts/" ;; esac; done
NAMES=("FLEET_PREFIX=acme" "FLEET_JAIL_PREFIX=zq" "FLEET_NAME=Acme Ops" "FLEET_REPO_URL=https://example.com/fleet" "FLEET_WAF_REFRESH_LABEL=com.example.fleet-waf-refresh")
LABEL="com.example.fleet-waf-refresh"
PLIST="$T/home/Library/LaunchAgents/$LABEL.plist"
LOG="$T/home/Library/Logs/acme-fleet-waf-refresh.log"
CFG="/etc/fail2ban/jail.d/acme-allowlist.local"

# everything <dir>: every folder and file under it, with each file's checksum. Two of these the same = nothing changed.
everything() { ( cd "$1" && find . | sort && find . -type f -exec cksum {} + | sort ) 2>/dev/null; }

# ==============================================================================
# A. The daily job on this machine
# ==============================================================================
PART=A; say "A. install-waf-refresh.sh"
CHECKOUT=main
job() { # [option]: run the installer; what it printed is in $OUT, its exit code in $RC
    OUT="$(cd "$NEW" && env -i PATH="$RUNPATH" HOME="$T/home" TMPDIR="$T/tmp" STATE="$T/state" FAKE_CHECKOUT="$CHECKOUT" "${NAMES[@]}" /bin/bash scripts/install-waf-refresh.sh "$@" 2>&1 </dev/null)"; RC=$?
}
asked() { grep -c "^$1" "$T/state/launchctl.log" 2>/dev/null || true; }
reset_log() { : > "$T/state/launchctl.log"; : > "$T/state/plutil.log"; }

reset_log; before="$(everything "$T/home")"
job
same "a plain run ends well and says it only looked" "$RC $(printf '%s\n' "$OUT" | grep -c '^Looked only\. Nothing was changed\.$')" "0 1"
same "it changed nothing under the home folder: no file, no folder" "$(everything "$T/home")" "$before"
same "it asked launchctl one thing: is the job loaded" "$(cat "$T/state/launchctl.log" | sed "s|gui/[0-9]*/|gui/N/|")" "print gui/N/$LABEL"
same "it loaded nothing and took nothing out" "$(asked bootstrap) $(asked bootout) $(ls "$T/state/loaded" 2>/dev/null | wc -l | tr -d ' ')" "0 0 0"
yes "it names the file --apply would write, as a new file" "$(printf '%s\n' "$OUT" | grep -qxF "  write   $PLIST   (a new file)" && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep write)"
yes "it names the job --apply would load" "$(printf '%s\n' "$OUT" | grep -q "^  load    the job $LABEL for your login" && echo 1 || echo 0)"
yes "it says what the job would run, and when" "$(printf '%s\n' "$OUT" | grep -qxF "  run     /bin/bash $NEW/scripts/waf-refresh.sh   once a day at 06:15" && echo 1 || echo 0)"
yes "it names the log" "$(printf '%s\n' "$OUT" | grep -qxF "  log to  $LOG" && echo 1 || echo 0)"
yes "it says the job is not loaded now" "$(printf '%s\n' "$OUT" | grep -q "^now:    the job $LABEL is not loaded$" && echo 1 || echo 0)"
yes "it says how to apply" "$(printf '%s\n' "$OUT" | grep -qxF '  bash scripts/install-waf-refresh.sh --apply' && echo 1 || echo 0)"

reset_log; job --apply
same "--apply ends well and says it installed" "$RC $(printf '%s\n' "$OUT" | grep -c "^installed $LABEL: daily at 06:15, running $NEW/scripts/waf-refresh.sh$")" "0 1"
yes "--apply wrote the job's file: its label, the script it runs and its log" "$([ -r "$PLIST" ] && grep -q "<string>$LABEL</string>" "$PLIST" && grep -q "<string>$NEW/scripts/waf-refresh.sh</string>" "$PLIST" && [ "$(grep -c "<string>$LOG</string>" "$PLIST")" = 2 ] && echo 1 || echo 0)"
same "--apply loaded it" "$(asked bootstrap) $(ls "$T/state/loaded" 2>/dev/null | wc -l | tr -d ' ')" "1 1"
same "--apply had the file checked before loading it" "$(cat "$T/state/plutil.log")" "-lint $PLIST"

reset_log; before="$(everything "$T/home")"
job
same "a plain run after that changes nothing either" "$RC $(asked bootstrap) $(asked bootout) $([ "$(everything "$T/home")" = "$before" ] && echo same || echo changed)" "0 0 0 same"
yes "and says the job is loaded and the file already says the same" "$(printf '%s\n' "$OUT" | grep -q "^now:    the job $LABEL is loaded$" && printf '%s\n' "$OUT" | grep -qxF "  write   $PLIST   (no change: the file there already says the same)" && printf '%s\n' "$OUT" | grep -q "^  reload  the job $LABEL " && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -E 'write|load' | tr '\n' ' ')"
sed "s|$NEW/scripts/waf-refresh.sh|/made/up/old/checkout/scripts/waf-refresh.sh|" "$PLIST" > "$T/plist.other" && cp "$T/plist.other" "$PLIST"
reset_log; before="$(everything "$T/home")"
job
yes "a plain run over a job file that differs says so, and says what that one runs" "$(printf '%s\n' "$OUT" | grep -qxF "  write   $PLIST   (replacing the file there, which differs)" && printf '%s\n' "$OUT" | grep -qxF '          it runs now: /made/up/old/checkout/scripts/waf-refresh.sh' && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -A1 write | tr '\n' ' ')"
same "and leaves that file as it is" "$([ "$(everything "$T/home")" = "$before" ] && echo same || echo changed) $(asked bootstrap)" "same 0"
reset_log; job --apply
same "--apply over it puts the file right and loads the job again: out, then in" "$RC $(grep -c "$NEW/scripts/waf-refresh.sh" "$PLIST") $(grep -c '^boot' "$T/state/launchctl.log" | tr -d ' ') $(sed -n '1p' "$T/state/launchctl.log" | cut -d' ' -f1)" "0 1 2 bootout"

reset_log; before="$(everything "$T/home")"
job --status
same "--status still only looks, and says installed" "$RC $(printf '%s\n' "$OUT" | grep -c "^installed: $LABEL$") $([ "$(everything "$T/home")" = "$before" ] && echo same || echo changed) $(asked bootstrap)$(asked bootout)" "0 1 same 00"
reset_log; before="$(everything "$T/home")"
job --install
same "an unknown option stops with exit 2 and changes nothing" "$RC $([ "$(everything "$T/home")" = "$before" ] && echo same || echo changed) $(wc -l < "$T/state/launchctl.log" | tr -d ' ')" "2 same 0"
reset_log; job --remove
same "--remove still takes the job out and removes its file" "$RC $(asked bootout) $(ls "$PLIST" "$T/state/loaded" 2>/dev/null | wc -l | tr -d ' ') $(printf '%s\n' "$OUT" | grep -c "^removed $LABEL$")" "0 1 0 1"
job --status
same "--status after that says not installed" "$RC $OUT" "0 not installed"

CHECKOUT=worktree; reset_log; before="$(everything "$T/home")"
job
yes "in a linked worktree a plain run says --apply would stop, and does not offer the command" "$([ "$RC" = 0 ] && printf '%s\n' "$OUT" | grep -q '^But --apply would stop here: this is a linked worktree' && ! printf '%s\n' "$OUT" | grep -q 'install-waf-refresh.sh --apply$' && echo 1 || echo 0)"
job --apply
same "and --apply there stops with exit 1, having written and loaded nothing" "$RC $([ "$(everything "$T/home")" = "$before" ] && echo same || echo changed) $(asked bootstrap)" "1 same 0"
CHECKOUT=none; reset_log; job --apply
same "control: outside a worktree the same --apply does install" "$RC $(asked bootstrap) $(ls "$PLIST" 2>/dev/null | wc -l | tr -d ' ')" "0 1 1"
job --remove

# ==============================================================================
# B. The operator allowlist on the servers
# ==============================================================================
PART=B; say "B. install-operator-allowlist.sh"
REPLY="$T/fx/reply-some"
allow() { # <case> [arguments]: run the script; what it sent is under $T/cap/<case>, what it printed in $OUT
    local cap="$T/cap/$1"; shift; rm -rf "$cap"; mkdir -p "$cap"
    OUT="$(cd "$NEW" && env -i PATH="$RUNPATH" HOME="$T/home" TMPDIR="$T/tmp" CAP="$cap" FLEET_SERVERS_FILE="$T/fx/servers" FAKE_SSH_REPLY="$REPLY" "${NAMES[@]}" /bin/bash scripts/install-operator-allowlist.sh "$@" 2>&1 </dev/null)"; RC=$?
}
calls() { cat "$T/cap/$1/count" 2>/dev/null || echo 0; }
sent() { tail -1 "$T/cap/$1/call-${2:-1}.args" 2>/dev/null; }     # the command a call asked the server to run
has() { printf '%s\n' "$OUT" | grep -qxF -- "$1" && echo 1 || echo 0; }

allow audit
same "with no argument it audits both servers, as before" "$RC $(calls audit) $(sent audit 1)" "0 2 bash -s 'audit' '$CFG' ''"
allow look 203.0.113.50 web1
same "an address on its own ends well and makes one call, to the one server named" "$RC $(calls look) $(grep -c '^root@203\.0\.113\.21$' "$T/cap/look/call-1.args")" "0 1 1"
same "that call asks for the audit, with no address in it" "$(sent look)" "bash -s 'audit' '$CFG' ''"
yes "what it sends is the audit's call to that server, byte for byte: the arguments and the program" "$(cmp -s "$T/cap/look/call-1.args" "$T/cap/audit/call-1.args" && cmp -s "$T/cap/look/call-1.stdin" "$T/cap/audit/call-1.stdin" && [ -s "$T/cap/look/call-1.stdin" ] && echo 1 || echo 0)"
same "nothing it sent asks for a change" "$(cat "$T/cap/look"/call-*.args | grep -c "'apply'\|'clear'\|'ufw-web")" "0"
yes "it says it looked and that nothing was changed" "$([ "$(has 'mode: look (this shows what --apply would change, and changes nothing)')" = 1 ] && [ "$(has 'Looked only. Nothing was changed. To make the change:')" = 1 ] && echo 1 || echo 0)"
yes "it shows the file --apply would replace and the one line it would write" "$([ "$(has "   --apply would replace $CFG with:")" = 1 ] && [ "$(has '       ignoreip = 127.0.0.0/8 ::1 203.0.113.50')" = 1 ] && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -A1 'would' | tr '\n' ' ' | cut -c1-200)"
same "it says which addresses are already there, which are new, and which would go" "$(printf '%s\n' "$OUT" | grep -E '^   (added to the list|already in the list|no longer in it):' | sed 's/  */ /g' | tr '\n' '|')" " added to the list: none| already in the list: 127.0.0.0/8 ::1 203.0.113.50| no longer in it: 198.51.100.7|"
yes "it prints the exact command that makes the change, with the address and the server" "$(has '  bash scripts/install-operator-allowlist.sh --apply 203.0.113.50 web1')" "$(printf '%s\n' "$OUT" | tail -2 | tr '\n' ' ')"
REPLY="$T/fx/reply-none"; allow look-new "203.0.113.50 198.51.100.0/24" web2
yes "on a server with no file it says a new file would be written, and counts both addresses as new" "$([ "$RC" = 0 ] && [ "$(calls look-new)" = 1 ] && [ "$(has "   --apply would write a new file, $CFG, with:")" = 1 ] && [ "$(has '       ignoreip = 127.0.0.0/8 ::1 203.0.113.50 198.51.100.0/24')" = 1 ] && printf '%s\n' "$OUT" | grep -q '^   added to the list:    203.0.113.50 198.51.100.0/24$' && printf '%s\n' "$OUT" | grep -q '^   no longer in it:      none$' && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -E 'would|list|longer' | tr '\n' ' ' | cut -c1-260)"
yes "several addresses come back quoted in the command it prints" "$(has '  bash scripts/install-operator-allowlist.sh --apply "203.0.113.50 198.51.100.0/24" web2')"
same "and the look still sent no address to the server" "$(sent look-new)" "bash -s 'audit' '$CFG' ''"
REPLY="$T/fx/reply-nof2b"; allow look-nof2b 203.0.113.50 web1
yes "where Fail2Ban is not installed it says --apply would change nothing there" "$(has '   --apply would change nothing here: Fail2Ban is not installed')"
REPLY="$T/fx/reply-none"; allow look-all 203.0.113.50
same "an address with no server looks at every server, and changes none" "$RC $(calls look-all) $(cat "$T/cap/look-all"/call-*.args | grep -c "^bash -s 'audit' ") $(has '  bash scripts/install-operator-allowlist.sh --apply 203.0.113.50')" "0 2 2 1"

REPLY="$T/fx/reply-some"
allow apply --apply 203.0.113.50 web1
same "--apply and an address sends the change to the one server named" "$(calls apply) $(sent apply)" "1 bash -s 'apply' '$CFG' '203.0.113.50'"
same "it says it is applying, and does not call itself a look" "$(has 'mode: apply') $(has 'allowlisting: 127.0.0.0/8 ::1 203.0.113.50') $(printf '%s\n' "$OUT" | grep -c 'Looked only')" "1 1 0"
allow apply-last 203.0.113.50 web1 --apply
yes "--apply after the address and the server sends the same call" "$(cmp -s "$T/cap/apply/call-1.args" "$T/cap/apply-last/call-1.args" && [ "$(calls apply-last)" = 1 ] && echo 1 || echo 0)" "$(sent apply-last)"
allow apply-mid 203.0.113.50 --apply web1
yes "--apply between them does too" "$(cmp -s "$T/cap/apply/call-1.args" "$T/cap/apply-mid/call-1.args" && [ "$(calls apply-mid)" = 1 ] && echo 1 || echo 0)" "$(sent apply-mid)"
allow apply-several --apply "203.0.113.50 198.51.100.0/24" web1
same "--apply with several addresses sends them all as one argument" "$(sent apply-several)" "bash -s 'apply' '$CFG' '203.0.113.50 198.51.100.0/24'"
allow apply-bare --apply
same "--apply with no address stops with exit 2 and contacts no server" "$RC $(calls apply-bare) $(printf '%s\n' "$OUT" | grep -c '^ABORT: --apply needs the address')" "2 0 1"
allow look-cgnat 100.64.1.1 web1
same "a shared carrier address is refused on a look too, before any server is contacted" "$RC $(calls look-cgnat) $(printf '%s\n' "$OUT" | grep -c 'carrier-grade NAT')" "1 0 1"
allow apply-cgnat --apply 100.64.1.1 web1
same "and on --apply, as before" "$RC $(calls apply-cgnat)" "1 0"
# --clear on its own looks; the file goes only with --apply.
looked() { [ "$(has 'Looked only. Nothing was changed. To make the change:')" = 1 ] && echo 1 || echo 0; }
asks_change() { cat "$T/cap/$1"/call-*.args 2>/dev/null | grep -c "'apply'\|'clear'\|'ufw-web"; }   # how many calls asked a server to change
REPLY="$T/fx/reply-some"; allow clear-look --clear web1
same "--clear on its own ends well and makes one call, the audit, to the server named" "$RC $(calls clear-look) $(sent clear-look) $(grep -c '^root@203\.0\.113\.21$' "$T/cap/clear-look/call-1.args")" "0 1 bash -s 'audit' '$CFG' '' 1"
yes "what it sends is the audit's call to that server, byte for byte" "$(cmp -s "$T/cap/clear-look/call-1.args" "$T/cap/audit/call-1.args" && cmp -s "$T/cap/clear-look/call-1.stdin" "$T/cap/audit/call-1.stdin" && [ -s "$T/cap/clear-look/call-1.stdin" ] && echo 1 || echo 0)"
same "nothing it sent asks for a change" "$(asks_change clear-look)" "0"
yes "it says it looked, and names the file --apply would remove" "$([ "$(has 'mode: look (this shows what --apply --clear would change, and changes nothing)')" = 1 ] && [ "$(looked)" = 1 ] && [ "$(has "   --apply would remove $CFG and reload Fail2Ban.")" = 1 ] && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -- '--apply' | tr '\n' ' ')"
yes "it prints the exact command that makes the change, with the server" "$(has '  bash scripts/install-operator-allowlist.sh --apply --clear web1')" "$(printf '%s\n' "$OUT" | tail -2 | tr '\n' ' ')"
REPLY="$T/fx/reply-none"; allow clear-look-all --clear
same "--clear with no server looks at every server; where no file is there it says so, on each" "$RC $(calls clear-look-all) $(asks_change clear-look-all) $(printf '%s\n' "$OUT" | grep -c "^   --apply would remove nothing here: $CFG is not there\.") $(has '  bash scripts/install-operator-allowlist.sh --apply --clear')" "0 2 0 2 1"
REPLY="$T/fx/reply-nof2b"; allow clear-look-nof2b --clear web1
same "where Fail2Ban is not installed it says --apply would change nothing, and offers no removal" "$(has '   --apply would change nothing here: Fail2Ban is not installed') $(printf '%s\n' "$OUT" | grep -c 'would remove')" "1 0"
REPLY="$T/fx/reply-some"; allow clear --apply --clear web1
same "--apply --clear removes the file on the server named" "$(calls clear) $(sent clear)" "1 bash -s 'clear' '$CFG' ''"
same "it says it is clearing, and does not call itself a look" "$(has 'mode: clear') $(printf '%s\n' "$OUT" | grep -c 'Looked only')" "1 0"
allow clear-last --clear web1 --apply
yes "--apply after --clear and the server sends the same call" "$(cmp -s "$T/cap/clear/call-1.args" "$T/cap/clear-last/call-1.args" && cmp -s "$T/cap/clear/call-1.stdin" "$T/cap/clear-last/call-1.stdin" && [ "$(calls clear-last)" = 1 ] && echo 1 || echo 0)" "$(sent clear-last)"

# The web ports: --ufw-web and --ufw-web-clear on their own read the firewall and change nothing.
REPLY="$T/fx/reply-ufw"; allow web-look --ufw-web "203.0.113.50 192.0.2.9" web2
same "--ufw-web on its own ends well and makes one call to the server named, with no address in it" "$RC $(calls web-look) $(sent web-look) $(grep -c '^root@203\.0\.113\.22$' "$T/cap/web-look/call-1.args") $(cat "$T/cap/web-look/call-1.args" "$T/cap/web-look/call-1.stdin" | grep -c '203\.0\.113\.50\|192\.0\.2\.9')" "0 1 bash -s 'look' 1 0"
same "nothing it sent asks for a change" "$(asks_change web-look)" "0"
same "the program it sends runs ufw for one thing only: its status" "$(grep -v '^ *#' "$T/cap/web-look/call-1.stdin" | grep -oE 'ufw +[a-z-]+' | sort -u | tr '\n' '|') $(grep -c '^ufw status ' "$T/cap/web-look/call-1.stdin")" "ufw status| 1"
same "that program reaches the server with this deployment's names filled in, and no placeholder" "$(grep -c '__FLEET_' "$T/cap/web-look/call-1.stdin") $(grep -c "^case 'acme' in " "$T/cap/web-look/call-1.stdin")" "0 1"
yes "it says it looked, which address --apply would open the ports to, and which is open already" "$([ "$(has 'mode: look (this shows what --apply --ufw-web would change, and changes nothing)')" = 1 ] && [ "$(looked)" = 1 ] && [ "$(has '   --apply would open ports 80 and 443 to: 192.0.2.9')" = 1 ] && [ "$(has '   already open to: 203.0.113.50')" = 1 ] && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -A1 -- '--apply would' | tr '\n' ' ')"
yes "it prints the exact command that makes the change, with the addresses quoted and the server" "$(has '  bash scripts/install-operator-allowlist.sh --apply --ufw-web "203.0.113.50 192.0.2.9" web2')" "$(printf '%s\n' "$OUT" | tail -2 | tr '\n' ' ')"
allow web-look-net --ufw-web 198.51.100.77/24 web2
yes "an address is compared on its network: 198.51.100.77/24 is the 198.51.100.0/24 already open" "$([ "$(has '   --apply would open ports 80 and 443 to: none')" = 1 ] && [ "$(has '   already open to: 198.51.100.77/24')" = 1 ] && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -A1 -- '--apply would' | tr '\n' ' ')"
allow web-off-look --ufw-web-clear "203.0.113.50 192.0.2.9" web2
same "--ufw-web-clear on its own makes the same one call, and asks for no change" "$RC $(calls web-off-look) $(sent web-off-look) $(asks_change web-off-look) $(cmp -s "$T/cap/web-off-look/call-1.stdin" "$T/cap/web-look/call-1.stdin" && echo same-program || echo another-program)" "0 1 bash -s 'look' 0 same-program"
yes "it says which address --apply would close the ports to, and which is not open now" "$([ "$(has 'mode: look (this shows what --apply --ufw-web-clear would change, and changes nothing)')" = 1 ] && [ "$(looked)" = 1 ] && [ "$(has '   --apply would close ports 80 and 443 to: 203.0.113.50')" = 1 ] && [ "$(has '   not open to them now, so nothing to remove: 192.0.2.9')" = 1 ] && echo 1 || echo 0)" "$(printf '%s\n' "$OUT" | grep -A1 -- '--apply would' | tr '\n' ' ')"
yes "and prints the exact command that closes them" "$(has '  bash scripts/install-operator-allowlist.sh --apply --ufw-web-clear "203.0.113.50 192.0.2.9" web2')" "$(printf '%s\n' "$OUT" | tail -2 | tr '\n' ' ')"
REPLY="$T/fx/reply-noufw"; allow web-look-noufw --ufw-web 203.0.113.50 web2
same "where UFW is not installed it says --apply would change nothing there" "$(has '   --apply would change nothing here: UFW is not installed') $(printf '%s\n' "$OUT" | grep -c 'would open ports')" "1 0"
REPLY="$T/fx/reply-ufw"; allow web-look-cgnat --ufw-web 100.64.1.1 web2
same "a shared carrier address is refused on this look too, before any server is contacted" "$RC $(calls web-look-cgnat) $(printf '%s\n' "$OUT" | grep -c 'carrier-grade NAT')" "1 0 1"
allow web-look-bare --ufw-web
same "--ufw-web with no address stops with exit 2 and contacts no server" "$RC $(calls web-look-bare)" "2 0"
allow web --apply --ufw-web 203.0.113.50 web2
same "--apply --ufw-web opens the web ports to an address" "$(calls web) $(sent web)" "1 bash -s 'ufw-web' '203.0.113.50'"
same "the program it sends is the one that adds the rule, not the one that only reads" "$(grep -c 'ufw prepend allow proto tcp from' "$T/cap/web/call-1.stdin") $(cmp -s "$T/cap/web/call-1.stdin" "$T/cap/web-look/call-1.stdin" && echo same-program || echo another-program)" "1 another-program"
same "it says what it is doing, and does not call itself a look" "$(has 'mode: ufw-web') $(printf '%s\n' "$OUT" | grep -c 'Looked only')" "1 0"
allow web-last --ufw-web 203.0.113.50 web2 --apply
yes "--apply at the end of the line sends the same call" "$(cmp -s "$T/cap/web/call-1.args" "$T/cap/web-last/call-1.args" && cmp -s "$T/cap/web/call-1.stdin" "$T/cap/web-last/call-1.stdin" && [ "$(calls web-last)" = 1 ] && echo 1 || echo 0)" "$(sent web-last)"
allow web-off --apply --ufw-web-clear 203.0.113.50 web2
same "--apply --ufw-web-clear closes them" "$(calls web-off) $(sent web-off) $(printf '%s\n' "$OUT" | grep -c 'Looked only')" "1 bash -s 'ufw-web-clear' '203.0.113.50' 0"
REPLY="$T/fx/reply-some"
allow unknown --force 203.0.113.50
same "an unknown option stops with exit 2 and contacts no server" "$RC $(calls unknown)" "2 0"
same "nothing in any of these runs was written under ~/.ssh" "$(ls -d "$T/home/.ssh" 2>/dev/null | wc -l | tr -d ' ')" "0"

# The two headers say what the scripts do.
same "the job installer's header shows the plain run as a look and --apply as the change" "$(sed -n '2,12p' "$NEW/scripts/install-waf-refresh.sh" | grep -c 'install-waf-refresh.sh              # look\|install-waf-refresh.sh --apply      # install')" "2"
same "the allowlist's header shows an address alone as a look and --apply as the change" "$(sed -n '10,25p' "$NEW/scripts/install-operator-allowlist.sh" | grep -c '203.0.113.50 web1    # LOOK\|--apply 203.0.113.50 web1    # apply')" "2"
same "and --clear and the two web-port forms the same way: a look, then the change with --apply" "$(sed -n '10,40p' "$NEW/scripts/install-operator-allowlist.sh" | grep -c -- '--clear web1          # LOOK\|--apply --clear web1  # remove\|--ufw-web 203.0.113.50 web2                 # LOOK\|--apply --ufw-web 203.0.113.50 web2         # open\|--ufw-web-clear 203.0.113.50 web2           # LOOK\|--apply --ufw-web-clear 203.0.113.50 web2   # close') $(sed -n '10,40p' "$NEW/scripts/install-operator-allowlist.sh" | grep -c 'NOTHING CHANGES A SERVER WITHOUT --apply')" "6 1"

echo
if [ "$fail" != 0 ]; then echo "$ran checks, $fail FAILED"; exit 1; fi
echo "$ran checks, 0 failed"
