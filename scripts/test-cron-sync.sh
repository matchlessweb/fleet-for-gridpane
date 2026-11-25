#!/bin/bash
# Self-test for scripts/cron-sync.sh. Nothing is synced and nothing is asked of
# GridPane or the database: a copy of the script runs in a made-up checkout with
# a stand-in `npm` that only writes down how it was called.
#
#   bash scripts/test-cron-sync.sh              # the checks
#   bash scripts/test-cron-sync.sh --controls   # also: break a copy one way at a time; each break must be caught
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${CRON_SYNC_UNDER_TEST:-$HERE/cron-sync.sh}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0; QUIET="${QUIET:-}"
ok()  { PASS=$((PASS+1)); [ -n "$QUIET" ] || echo "  pass  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got \"$2\", wanted \"$3\")"; fi; }

if [ "${1:-}" = "--controls" ]; then
    echo "Controls: each broken copy of the script must fail at least one check."
    base="$(QUIET=1 bash "$0" | tail -1)"
    case "$base" in *" 0 failed") ;; *) echo "The checks do not pass on the script as it is ($base), so a control would prove nothing."; exit 1 ;; esac
    CAUGHT=0; MISSED=0; N=0
    try() {  # name, sed program
        N=$((N+1)); local copy="$T/broken-$N.sh" out
        sed "$2" "$SCRIPT" > "$copy"
        if cmp -s "$copy" "$SCRIPT"; then MISSED=$((MISSED+1)); echo "  MISSED  $1 (the control itself did not apply)"; return; fi
        out="$(CRON_SYNC_UNDER_TEST="$copy" QUIET=1 bash "$0" | tail -1)"
        case "$out" in *" 0 failed") MISSED=$((MISSED+1)); echo "  MISSED  $1" ;; *) CAUGHT=$((CAUGHT+1)); echo "  caught  $1" ;; esac
    }
    try "it runs a runner that is not installed, not the npm script" 's/^npm run -s sync >>/npx tsx scripts\/sync-gridpane.ts >>/'
    try "it runs the sync from wherever it was started"              's/^cd "\$(cd "\$(dirname "\$0")\/\.\." \&\& pwd)" || exit 1$/true/'
    try "each run replaces the log"                                  's/^npm run -s sync >> "\$LOG" 2>&1$/npm run -s sync > "$LOG" 2>\&1/'
    try "a failed sync exits 0"                                      's/^npm run -s sync >> "\$LOG" 2>&1$/npm run -s sync >> "$LOG" 2>\&1; exit 0/'
    try "what the sync prints is thrown away"                        's/^npm run -s sync >> "\$LOG" 2>&1$/npm run -s sync > \/dev\/null 2>\&1/'
    try "with no log named, the log goes somewhere else"             "s|^    LOG=\"\\\$LOGDIR/gridpane-sync.log\"\$|    LOG=\"$T/elsewhere.log\"|"
    try "the log's folder is left open to others"                   's/ \&\& chmod 700 "\$LOGDIR"//'
    echo "controls: $CAUGHT caught, $MISSED missed, of $((CAUGHT+MISSED))"
    [ "$MISSED" = 0 ]; exit $?
fi

# A made-up checkout holding the copy, and stand-ins that write down their call and print one line.
mkdir -p "$T/checkout/scripts" "$T/bin" "$T/home" "$T/elsewhere"
cp "$SCRIPT" "$T/checkout/scripts/cron-sync.sh"
for tool in npm npx; do
    printf '#!/bin/bash\nprintf "%%s|%%s|%%s\\n" "%s" "$PWD" "$*" >> "%s/calls"\necho "stand-in sync output"\nexit "${FAKE_RC:-0}"\n' "$tool" "$T" > "$T/bin/$tool"
    chmod +x "$T/bin/$tool"
done
# The usual places are listed after the PATH given, so a real npm in one of them is not the one found.
run() { (cd "$T/elsewhere" && env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" FLEET_SYNC_LOG="$T/sync.log" FAKE_RC="${1:-0}" bash "$T/checkout/scripts/cron-sync.sh"); }
REAL="$(cd "$T/checkout" && pwd -P)"
calls() { [ -f "$T/calls" ] && cat "$T/calls"; }

[ -n "$QUIET" ] || echo "Started from another folder, the way a scheduler starts it:"
run; rc=$?
check "it ends with the sync's exit code (0)" "$rc" "0"
check "one command was run" "$(calls | wc -l | tr -d ' ')" "1"
check "it is npm, with the script's name: the command you run by hand" "$(calls | cut -d'|' -f1,3)" "npm|run -s sync"
check "run in the checkout the script is in, not where it was started" "$(cd "$(calls | cut -d'|' -f2 | head -1)" 2>/dev/null && pwd -P)" "$REAL"
check "what the sync printed is in the log" "$(cat "$T/sync.log" 2>/dev/null)" "stand-in sync output"
run 7; rc=$?
check "a failed sync is this script's failure (exit 7)" "$rc" "7"
check "the log is added to, not replaced" "$(grep -c 'stand-in sync output' "$T/sync.log" 2>/dev/null)" "2"

# With no log named, it goes under the home folder, in a folder nobody else can read (never /tmp).
(cd "$T/elsewhere" && env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" bash "$T/checkout/scripts/cron-sync.sh")
check "with no log named, the log is under the home folder" "$(cat "$T/home/.local/state/fleet/gridpane-sync.log" 2>/dev/null)" "stand-in sync output"
check "and its folder is the owner's alone" "$(stat -f '%Lp' "$T/home/.local/state/fleet" 2>/dev/null || stat -c '%a' "$T/home/.local/state/fleet" 2>/dev/null)" "700"

[ -n "$QUIET" ] || echo "What it leans on:"
check "package.json has a sync script that runs scripts/sync-gridpane.ts" "$(node -e 'const s=require(process.argv[1]).scripts.sync||"";console.log(/scripts\/sync-gridpane\.ts/.test(s)?"yes":"no")' "$HERE/../package.json")" "yes"
check "the script names no runner that is not a dependency (tsx, npx)" "$(grep -v '^#' "$SCRIPT" | grep -cE 'tsx|npx')" "0"
bash -n "$SCRIPT" 2>/dev/null; check "it is valid bash" "$?" "0"

echo "cron-sync test: $((PASS+FAIL)) checks, $FAIL failed"
[ "$FAIL" = 0 ]
