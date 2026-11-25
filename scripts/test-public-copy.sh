#!/usr/bin/env bash
# Does the PUBLIC copy work? Your own checkout runs its tests under your own
# settings (fleet.config.ts); the public copy runs under the example settings.
# A test that quietly depends on your prefix or your site list passes here and
# fails there. This exports the last commit to a temporary folder and runs the
# type check and every suite package.json names (every script ending in :test)
# inside it. It takes a few minutes.
#
#   bash scripts/test-public-copy.sh            # export the last commit, test it
#   bash scripts/test-public-copy.sh --keep     # the same, and leave the folder for you to look at
#
# It needs this checkout's node_modules (the copy links to it; nothing is
# installed) and your denylist, because it goes through scripts/export-public.sh.
# The privacy verdict is printed too, but this script's own result is about the
# tests: exit 0 when the copy runs no Patchstack step, type-checks, and every suite passes.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
[ -d "$ROOT/node_modules" ] || { echo "No node_modules in $ROOT: run npm install first."; echo "public_copy=blind"; exit 3; }
BASE="$(mktemp -d)"; OUT="$BASE/copy"
[ "$KEEP" = 1 ] || trap 'rm -rf "$BASE"' EXIT

EXPORT="$(bash "$HERE/export-public.sh" "$OUT" --no-gate-test 2>&1)"; ERC=$?
echo "$EXPORT" | grep -E "^Exported|^Note:" ; PRIV="$(echo "$EXPORT" | tail -1)"
[ -f "$OUT/package.json" ] || { echo "$EXPORT" | tail -5; echo "The export made no copy to test."; echo "public_copy=blind"; exit 3; }
ln -s "$ROOT/node_modules" "$OUT/node_modules"
cd "$OUT" || exit 3

FAILED=0; RAN=0
step() {  # name, command...
  local name="$1"; shift; local out rc
  out="$("$@" 2>&1)"; rc=$?; RAN=$((RAN+1))
  if [ "$rc" = 0 ]; then echo "  pass  $name  —  $(printf '%s\n' "$out" | tail -1 | cut -c1-90)"; else FAILED=$((FAILED+1)); echo "  FAIL  $name (exit $rc)"; printf '%s\n' "$out" | grep -iE "fail|error|missed" | head -6 | sed 's/^/        /' | cut -c1-220; fi
}
echo "In the public copy, under the example settings:"
# With no site settings, `patchstack-connect scan` makes a Patchstack site and sends it the package
# list. The copy must not do that on a stranger's install or build (scripts/export-public.rules).
step "no npm script calls Patchstack" node -e 'const fs=require("fs");const s=require("./package.json").scripts||{};const hit=Object.keys(s).filter(k=>/patchstack-connect/.test(s[k]));if(hit.length){console.error("error: these npm scripts call patchstack-connect: "+hit.join(", "));process.exit(1)}if(fs.existsSync(".patchstackrc.json")){console.error("error: .patchstackrc.json is in the copy");process.exit(1)}console.log("none of "+Object.keys(s).length+" npm scripts calls patchstack-connect, and there is no .patchstackrc.json")'
step "type check" npx tsc --noEmit -p .
# Every suite package.json names: the same list the public copy's own checks run (.github/ci.example.yml).
# The ones that need a database engine run too: @electric-sql/pglite is a dev dependency.
SUITES="$(node -e 'const s=require("./package.json").scripts;console.log(Object.keys(s).filter(k=>/:test$/.test(k)).join(" "))')"
for s in $SUITES; do step "npm run $s" npm run -s "$s"; done

echo
echo "privacy verdict for this copy: ${PRIV#export_public=} (exit $ERC); see npm run export:check for the list"
[ "$KEEP" = 1 ] && echo "The copy is left at $OUT"
echo "public copy: $RAN steps, $FAILED failed"
if [ "$FAILED" = 0 ]; then echo "public_copy=pass"; exit 0; else echo "public_copy=fail"; exit 1; fi
