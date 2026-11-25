#!/usr/bin/env bash
# Proves scripts/export-public.sh on a small made-up repository: what it leaves
# out, what it replaces, that a private detail stops it, that "could not look"
# stops it, and that it never makes a repository from a copy that is not clean.
#
#   bash scripts/test-export-public.sh              # the checks
#   bash scripts/test-export-public.sh --controls   # also: break the script on purpose, each break must be caught
#
# It uses its own denylist and temporary folders only. Nothing is pushed anywhere.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
EXPORT="${FLEET_EXPORT_UNDER_TEST:-$HERE/export-public.sh}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()    { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); [ -n "${QUIET:-}" ] || echo "  pass  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1: got '$2', wanted '$3'"; fi; }
has()   { case "$2" in *"$3"*) PASS=$((PASS+1)); [ -n "${QUIET:-}" ] || echo "  pass  $1";; *) FAIL=$((FAIL+1)); echo "  FAIL  $1: '$3' is not in the output";; esac; }
hasnt() { case "$2" in *"$3"*) FAIL=$((FAIL+1)); echo "  FAIL  $1: '$3' is in the output";; *) PASS=$((PASS+1)); [ -n "${QUIET:-}" ] || echo "  pass  $1";; esac; }
yes_no() { if eval "$1"; then echo yes; else echo no; fi; }
run()   { OUT="$(bash "$EXPORT" --source "$T/src" --denylist "$DENY" "$@" 2>&1)"; RC=$?; LAST="$(printf '%s\n' "$OUT" | tail -1)"; }

SECRET="quarrystone"           # the made-up private name
DENY="$T/deny"; printf '%s\n' "$SECRET" > "$DENY"
G() { git -C "$T/src" -c user.name="Test" -c user.email="test@example.com" "$@"; }

setup() {  # a small repository: private settings beside their examples, and notes to leave out
  rm -rf "$T/src" "$T/out"; mkdir -p "$T/src/scripts" "$T/src/src"
  cp "$HERE/privacy-gate.mjs" "$HERE/privacy-allowlist.txt" "$HERE/export-public.rules" "$HERE/test-privacy-gate.sh" "$T/src/scripts/"
  echo "# A dashboard" > "$T/src/README.md"
  echo "export const site = \"shop.example.com\";" > "$T/src/src/app.ts"
  echo "export default { name: \"$SECRET fleet\" };" > "$T/src/fleet.config.ts"
  echo "export default { name: \"Fleet\" };" > "$T/src/fleet.config.example.ts"
  echo "{ \"name\": \"$SECRET-fleet\" }" > "$T/src/wrangler.jsonc"
  echo "{ \"name\": \"fleet\" }" > "$T/src/wrangler.example.jsonc"
  mkdir -p "$T/src/.github"; printf '%s\n' "name: checks" "on: [push, pull_request]" > "$T/src/.github/ci.example.yml"
  printf '%s\n' "name: checks on Linux" "on: workflow_dispatch" > "$T/src/.github/linux.example.yml"
  echo "# Notes for $SECRET's own tools" > "$T/src/GEMINI.md"
  printf '%s\n' "# Rules for agents" "Keep this line." "<!-- BEGIN house:multi-agent (managed) -->" "Ask $SECRET first." "<!-- END house:multi-agent -->" "And this line." > "$T/src/AGENTS.md"
  # Patchstack: this install's site and credential, beside the starter files the public copy gets
  echo "const PS_SITE_UUID = \"$SECRET-site\";" > "$T/src/patchstack.next.ts"
  echo "const PS_SITE_UUID = \"__PATCHSTACK_SITE_UUID__\";" > "$T/src/patchstack.next.ts.example"
  echo "{ \"_patchstack\": { \"rules_reader\": \"$SECRET-reader\" } }" > "$T/src/patchstack.rules.json"
  echo "{ \"firewall\": [] }" > "$T/src/patchstack.rules.example.json"
  echo "{ \"siteUuid\": \"$SECRET-site\" }" > "$T/src/.patchstackrc.json"
  # Patchstack's install and build steps, which the public copy leaves out, beside a script it keeps
  printf '%s\n' '{' '  "name": "fleet",' '  "scripts": {' '    "build": "next build",' '    "postinstall": "patchstack-connect scan",' '    "prebuild": "patchstack-connect scan && patchstack-connect map --upload",' '    "postbuild": "patchstack-connect mark-build"' '  }' '}' > "$T/src/package.json"
  mkdir -p "$T/src/app"; printf '%s\n' "<body>" "{/* BEGIN :patchstack-widget */}" "<script data-site-uuid=\"$SECRET-site\"></script>" "{/* END :patchstack-widget */}" "</body>" > "$T/src/app/layout.tsx"
  git init -q -b main "$T/src" && G add -A && G commit -q -m "first" || { echo "could not build the test repository"; exit 1; }
}

checks() {
  echo "A dry run on a repository whose private details are all covered by the rules:"
  setup; run --check
  ok "ends clean, exit 0" "$LAST/$RC" "export_public=clean/0"
  has "says what it copied and what the rules did" "$OUT" "21 files copied, 2 left out, 6 replaced by their example, 2 trimmed, 3 npm scripts left out; 21 files in the export"
  has "the gate looked, with the list" "$OUT" "1 of your own terms"
  has "and says the temporary folder is gone" "$OUT" "The temporary folder is removed"

  echo "A real export into a new folder:"
  setup; run "$T/out" --no-gate-test
  ok "ends clean, exit 0" "$LAST/$RC" "export_public=clean/0"
  ok "the notes file is left out" "$(yes_no '[ ! -e "$T/out/GEMINI.md" ]')" "yes"
  ok "the settings file is the example's text" "$(cat "$T/out/fleet.config.ts")" "$(cat "$T/src/fleet.config.example.ts")"
  ok "the Worker settings are the example's text" "$(cat "$T/out/wrangler.jsonc")" "$(cat "$T/src/wrangler.example.jsonc")"
  ok "the examples are published too" "$(yes_no '[ -f "$T/out/fleet.config.example.ts" ] && [ -f "$T/out/wrangler.example.jsonc" ] && [ -f "$T/out/.github/ci.example.yml" ]')" "yes"
  ok "the workflow is published where GitHub runs it, as the example's text" "$(cat "$T/out/.github/workflows/ci.yml" 2>&1)" "$(cat "$T/src/.github/ci.example.yml")"
  ok "the Linux workflow is published too, as its example's text" "$(cat "$T/out/.github/workflows/linux.yml" 2>&1)" "$(cat "$T/src/.github/linux.example.yml")"
  ok "the source repository has no workflow GitHub would run" "$(yes_no '[ ! -e "$T/src/.github/workflows" ]')" "yes"
  ok "the managed block is cut out, the lines around it kept" "$(tr '\n' '|' < "$T/out/AGENTS.md")" "# Rules for agents|Keep this line.|And this line.|"
  ok "Patchstack's guard is the starter's text" "$(cat "$T/out/patchstack.next.ts")" "$(cat "$T/src/patchstack.next.ts.example")"
  ok "Patchstack's rules are the starter's, with no credential" "$(cat "$T/out/patchstack.rules.json")" "$(cat "$T/src/patchstack.rules.example.json")"
  ok "Patchstack's site settings are left out" "$(yes_no '[ ! -e "$T/out/.patchstackrc.json" ]')" "yes"
  ok "the widget tag naming the site is cut out of the layout" "$(tr '\n' '|' < "$T/out/app/layout.tsx")" "<body>|</body>|"
  ok "Patchstack's install and build steps are left out of package.json, the rest kept as it was" "$(cat "$T/out/package.json")" "$(printf '%s\n' '{' '  "name": "fleet",' '  "scripts": {' '    "build": "next build"' '  }' '}')"
  ok "no script in the copy runs patchstack-connect" "$(grep -c patchstack-connect "$T/out/package.json")" "0"
  ok "the source's package.json is untouched" "$(grep -c patchstack-connect "$T/src/package.json")" "3"
  ok "the private name is nowhere in the folder" "$(grep -rl "$SECRET" "$T/out" | wc -l | tr -d ' ')" "0"
  ok "no repository is made" "$(yes_no '[ ! -e "$T/out/.git" ]')" "yes"
  ok "no history comes along" "$(find "$T/out" -name .git | wc -l | tr -d ' ')" "0"
  ok "no marker file on a clean export" "$(yes_no '[ ! -e "$T/out/NOT-PUBLISHABLE.txt" ]')" "yes"
  has "it says how to make the repository" "$OUT" "--commit --name"

  echo "With --commit:"
  setup; run "$T/out" --commit --name "Pat Example" --email "pat@example.com"
  ok "ends clean, exit 0" "$LAST/$RC" "export_public=clean/0"
  has "the gate's own test ran first" "$OUT" "The gate's own test passes"
  ok "one commit" "$(git -C "$T/out" rev-list --count HEAD 2>/dev/null)" "1"
  ok "by the name and address given, as author and committer" "$(git -C "$T/out" log -1 --format='%an <%ae> / %cn <%ce>' 2>/dev/null)" "Pat Example <pat@example.com> / Pat Example <pat@example.com>"
  ok "no remote" "$(git -C "$T/out" remote 2>/dev/null | wc -l | tr -d ' ')" "0"
  ok "nothing left uncommitted" "$(git -C "$T/out" status --porcelain 2>/dev/null | wc -l | tr -d ' ')" "0"
  has "it says nothing was pushed" "$OUT" "No remote was added and nothing was pushed"

  echo "A private detail the rules do not cover:"
  setup; echo "// ask $SECRET" >> "$T/src/src/app.ts"; G add src/app.ts; G commit -q -m "leak"
  run "$T/out" --no-gate-test
  ok "ends findings, exit 1" "$LAST/$RC" "export_public=findings/1"
  has "names the file and line" "$OUT" "src/app.ts:2  your-term  $SECRET"
  ok "the folder is marked" "$(yes_no '[ -f "$T/out/NOT-PUBLISHABLE.txt" ]')" "yes"
  ok "no repository is made" "$(yes_no '[ ! -e "$T/out/.git" ]')" "yes"
  rm -rf "$T/out"; run "$T/out" --commit --name "Pat Example" --email "pat@example.com"
  ok "with --commit: still findings, exit 1" "$LAST/$RC" "export_public=findings/1"
  ok "with --commit: still no repository" "$(yes_no '[ ! -e "$T/out/.git" ]')" "yes"
  run --check
  ok "the dry run says the same" "$LAST/$RC" "export_public=findings/1"

  echo "Work that is not committed:"
  setup; echo "// ask $SECRET" >> "$T/src/src/app.ts"
  run --check
  ok "an export of the commit does not see it: clean" "$LAST/$RC" "export_public=clean/0"
  has "and says so" "$OUT" "changes that are not committed. They are NOT in the export"
  run --check --from-disk
  ok "--from-disk does see it: findings" "$LAST/$RC" "export_public=findings/1"
  has "and says it read the disk" "$OUT" "as they are on disk (not a commit)"

  echo "A rule that cannot be carried out:"
  setup; G rm -q fleet.config.example.ts; G commit -q -m "no example"
  run "$T/out" --no-gate-test
  ok "a missing example stops it (the private file must not go out in its place)" "$LAST/$RC" "export_public=failed/1"
  has "and it names the example" "$OUT" "the example fleet.config.example.ts is not in the export"
  setup; printf '%s\n' "# Rules" "<!-- BEGIN house:multi-agent -->" "Ask $SECRET first." > "$T/src/AGENTS.md"; G add AGENTS.md; G commit -q -m "open block"
  run --check
  ok "a block with no END line stops it" "$LAST/$RC" "export_public=failed/1"
  setup; echo "publish everything" >> "$T/src/scripts/export-public.rules"; G add scripts; G commit -q -m "bad rule"
  run --check
  ok "an unknown rule stops it" "$LAST/$RC" "export_public=failed/1"
  setup; echo "drop ../elsewhere" >> "$T/src/scripts/export-public.rules"; G add scripts; G commit -q -m "bad path"
  run --check
  ok "a rule that points outside the repository stops it" "$LAST/$RC" "export_public=failed/1"

  setup; node -e 'const f=process.argv[1],p=require(f);delete p.scripts.postbuild;require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$T/src/package.json"; G add package.json; G commit -q -m "no postbuild"
  run --check
  ok "an npm script that is not there is a note, not a stop" "$LAST/$RC" "export_public=clean/0"
  has "and the note names it" "$OUT" "drops the npm script postbuild, which package.json does not have"
  setup; echo "drop-script" >> "$T/src/scripts/export-public.rules"; G add scripts; G commit -q -m "no script name"
  run --check
  ok "drop-script with no name stops it" "$LAST/$RC" "export_public=failed/1"
  setup; echo "{ not json" > "$T/src/package.json"; G add package.json; G commit -q -m "bad json"
  run --check
  ok "a package.json it cannot read stops it" "$LAST/$RC" "export_public=failed/1"

  echo "Could not look is never a pass:"
  setup; OUT="$(bash "$EXPORT" --source "$T/src" --denylist "$T/no-such-list" --check 2>&1)"; RC=$?; LAST="$(printf '%s\n' "$OUT" | tail -1)"
  ok "no denylist: blind, exit 3" "$LAST/$RC" "export_public=blind/3"
  has "and it says how to make one" "$OUT" "npm run privacy:denylist"
  : > "$T/empty-deny"; OUT="$(bash "$EXPORT" --source "$T/src" --denylist "$T/empty-deny" --check 2>&1)"; RC=$?; LAST="$(printf '%s\n' "$OUT" | tail -1)"
  ok "an empty denylist: blind, exit 3" "$LAST/$RC" "export_public=blind/3"
  setup; touch -t 202001010000 "$DENY"; run "$T/out" --commit --name "Pat Example" --email "pat@example.com"
  ok "an old denylist stops a commit: blind, exit 3" "$LAST/$RC" "export_public=blind/3"
  ok "and nothing was exported" "$(yes_no '[ ! -e "$T/out" ]')" "yes"
  run --check
  ok "an old denylist still allows a dry run" "$LAST/$RC" "export_public=clean/0"
  has "with a note about its age" "$OUT" "day(s) old"
  printf '%s\n' "$SECRET" > "$DENY"
  mkdir -p "$T/plain"; OUT="$(bash "$EXPORT" --source "$T/plain" --denylist "$DENY" --check 2>&1)"; RC=$?; LAST="$(printf '%s\n' "$OUT" | tail -1)"
  ok "a folder that is not a checkout: blind, exit 3" "$LAST/$RC" "export_public=blind/3"

  echo "Where it will not write:"
  setup; mkdir -p "$T/out"; echo "mine" > "$T/out/keep.txt"; run "$T/out" --no-gate-test
  ok "a folder with something in it is refused" "$LAST/$RC" "export_public=failed/1"
  ok "and left as it was" "$(ls "$T/out" | tr '\n' ' ')" "keep.txt "
  run "$T/src/public" --no-gate-test
  ok "a folder inside the checkout is refused" "$LAST/$RC" "export_public=failed/1"

  echo "Wrong usage (exit 2, nothing done):"
  setup
  run;                                                             ok "no folder and no --check" "$LAST/$RC" "export_public=failed/2"
  run --check "$T/out";                                            ok "--check with a folder" "$LAST/$RC" "export_public=failed/2"
  run "$T/out" --from-disk;                                        ok "--from-disk without --check" "$LAST/$RC" "export_public=failed/2"
  run "$T/out" --commit;                                           ok "--commit with no name or address" "$LAST/$RC" "export_public=failed/2"
  run "$T/out" --commit --name "Pat Example";                      ok "--commit with no address" "$LAST/$RC" "export_public=failed/2"
  run "$T/out" --commit --email "pat@example.com";                 ok "--commit with no name" "$LAST/$RC" "export_public=failed/2"
  run "$T/out" --commit --name "Pat Example" --email "not-an-address"; ok "--commit with a bad address" "$LAST/$RC" "export_public=failed/2"
  run "$T/out" --commit --name "Pat Example" --email "pat@example.com" --no-gate-test; ok "--commit will not skip the gate's test" "$LAST/$RC" "export_public=failed/2"
  run "$T/out" --push;                                             ok "an unknown option" "$LAST/$RC" "export_public=failed/2"
  ok "none of them made the folder" "$(yes_no '[ ! -e "$T/out" ]')" "yes"
}

if [ "${1:-}" = "--controls" ]; then
  echo "Controls: each broken copy of the export script must fail at least one check."
  BASE="$(QUIET=1 bash "$0" 2>&1 | tail -1)"
  case "$BASE" in *" 0 failed"*) ;; *) echo "The checks do not pass on the script as it is ($BASE), so a control would prove nothing. Fix that first."; exit 1;; esac
  CAUGHT=0; MISSED=0
  try() {  # name, a node expression that edits the source text `s`
    local copy="$HERE/.export-public.broken.$$.sh"
    node -e 'const fs=require("fs");let s=fs.readFileSync(process.argv[1],"utf8");const before=s;s=eval(process.argv[3]);if(s===before){console.error("the edit changed nothing");process.exit(9)}fs.writeFileSync(process.argv[2],s)' "$EXPORT" "$copy" "$2" || { MISSED=$((MISSED+1)); echo "  MISSED  $1 (the control itself did not apply)"; rm -f "$copy"; return; }
    local out; out="$(FLEET_EXPORT_UNDER_TEST="$copy" QUIET=1 bash "$0" 2>&1 | tail -1)"; rm -f "$copy"
    case "$out" in *" 0 failed"*) MISSED=$((MISSED+1)); echo "  MISSED  $1";; *) CAUGHT=$((CAUGHT+1)); echo "  caught  $1";; esac
  }
  try "findings still end clean"                      's.replace("     finish findings 1;;\n  *) echo \"The gate could not look", "     ;;\n  *) echo \"The gate could not look")'
  try "a gate that could not look ends clean"         's.replace("     finish blind 3;;\nesac", "     ;;\nesac")'
  try "a missing denylist is let through"             's.replace("if [ ! -f \"$DENY\" ]; then", "if false; then")'
  try "an old denylist allows a commit"               's.replace("if [ \"$AGE_DAYS\" -ge 7 ] && [ \"$COMMIT\" = 1 ]; then", "if false; then")'
  try "drop rules are not carried out"                's.replace("rm -rf \"${OUT:?}/$2\"; DROPPED", ": ; DROPPED")'
  try "the example is not copied over the private file" 's.replace("cp \"$OUT/$2\" \"$OUT/$4\" || finish failed 1; USED", ": ; USED")'
  try "the folder for a replaced file is not made"     's.replace("mkdir -p \"$(dirname \"$OUT/$4\")\" && cp", "cp")'
  try "a missing example is ignored"                  's.replace("[ -f \"$OUT/$2\" ] || { echo \"$RULES:$N: the example", "true || { echo \"$RULES:$N: the example")'
  try "the block is not cut"                          's.replace("else mv \"$OUT/$2.cut\" \"$OUT/$2\"; CUT", "else rm -f \"$OUT/$2.cut\"; CUT")'
  try "an open block is cut to the end without a word" 's.replace("END {if (skip) exit 7;", "END {")'
  try "an unknown rule is skipped"                    's.replace("*) echo \"$RULES:$N: unknown rule", "*) continue; echo \"$RULES:$N: unknown rule")'
  try "a path outside the repository is accepted"     's.replace("case \"$1\" in \"\"|/*|*..*) return 1;; esac; return 0;", "return 0;")'
  try "a folder that is not empty is written into"    's.replace("[ -d \"$TARGET\" ] && [ -z \"$(ls -A \"$TARGET\")\" ] ||", "true ||")'
  try "a folder inside the checkout is accepted"      's.replace("case \"$OUT/\" in \"$(cd \"$SOURCE\" && pwd -P)\"/*)", "case \"$OUT/\" in /no/such/place/*)")'
  try "the commit is made even with findings"         's.replace("  1) echo \"NOT publishable: the gate found the items listed above.\"", "  1) RC=0; echo \"NOT publishable: the gate found the items listed above.\"").replace("     finish findings 1;;\n  *) echo \"The gate could not look", "     ;;\n  *) echo \"The gate could not look")'
  try "the commit takes this machine's name"          's.replace("GIT_AUTHOR_NAME=\"$NAME\" GIT_AUTHOR_EMAIL=\"$EMAIL\" GIT_COMMITTER_NAME=\"$NAME\" GIT_COMMITTER_EMAIL=\"$EMAIL\" git", "GIT_AUTHOR_NAME=\"Someone Else\" GIT_AUTHOR_EMAIL=\"else@example.com\" GIT_COMMITTER_NAME=\"Someone Else\" GIT_COMMITTER_EMAIL=\"else@example.com\" git")'
  try "--commit needs no name"                        's.replace("[ -n \"$NAME\" ] && [ -n \"$EMAIL\" ] || usage", "true || usage")'
  try "--commit may skip the gate test"               's.replace("[ \"$COMMIT\" = 1 ] && [ \"$GATE_TEST\" = 0 ] && usage", "false && usage")'
  try "a repository is made without --commit"         's.replace("if [ \"$COMMIT\" = 0 ]; then", "if false; then").replace("[ -n \"$NAME\" ] && [ -n \"$EMAIL\" ] || usage", "true || usage")'
  try "uncommitted work is exported from a commit run" 's.replace("git -C \"$SOURCE\" archive HEAD | tar -x -C \"$OUT\" ||", "(cd \"$SOURCE\" && git ls-files -z | xargs -0 tar -cf -) | tar -x -C \"$OUT\" ||")'
  try "--from-disk reads the commit"                  's.replace("if [ \"$FROM_DISK\" = 1 ]; then\n  FROM=", "if false; then\n  FROM=")'
  try "the marker file is not written"                's.replace("{ echo \"NOT publishable: the privacy gate found private details in this folder. See scripts/export-public.sh.\" > \"$OUT/NOT-PUBLISHABLE.txt\";", "{ :;")'
  try "drop-script rules are not carried out"          's.replace("delete p.scripts[n];", "")'
  try "a missing npm script stops the export"         's.replace("process.exit(8);delete", "process.exit(3);delete")'
  try "package.json loses its indentation"            's.replace("JSON.stringify(p,null,ind)", "JSON.stringify(p)")'
  try "a package.json it cannot read is let through"  's.replace("*) echo \"$RULES:$N: could not take the npm script", "*) :; echo \"$RULES:$N: could not take the npm script").replace("Stopping.\" >&2; finish failed 1;;\n        esac", "Stopping.\" >&2;;\n        esac")'
  try "an unknown option is ignored"                  's.replace("--*) usage \"Unknown option: $1\";;", "--*) ;;")'
  echo "controls: $CAUGHT caught, $MISSED missed, of $((CAUGHT+MISSED))"
  [ "$MISSED" = 0 ] || exit 1
  exit 0
fi

checks
echo "export: $((PASS+FAIL)) checks, $FAIL failed"
[ "$FAIL" = 0 ]
