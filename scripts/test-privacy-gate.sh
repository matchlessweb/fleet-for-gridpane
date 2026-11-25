#!/usr/bin/env bash
# Proves scripts/privacy-gate.mjs: it finds one planted value of every kind, it
# passes a tree that holds only made-up values, and it says "could not look"
# rather than "clean" when it has nothing to look with.
#
#   bash scripts/test-privacy-gate.sh              # the checks
#   bash scripts/test-privacy-gate.sh --controls   # also: break the gate on purpose, each break must be caught
#
# Nothing here touches your own denylist or the network. Every planted value is
# built from pieces at run time, so this file holds nothing the gate would flag.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${FLEET_GATE_UNDER_TEST:-$HERE/privacy-gate.mjs}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()    { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); [ -n "${QUIET:-}" ] || echo "  pass  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1: got '$2', wanted '$3'"; fi; }
has()   { case "$2" in *"$3"*) PASS=$((PASS+1)); [ -n "${QUIET:-}" ] || echo "  pass  $1";; *) FAIL=$((FAIL+1)); echo "  FAIL  $1: '$3' is not in the output";; esac; }
hasnt() { case "$2" in *"$3"*) FAIL=$((FAIL+1)); echo "  FAIL  $1: '$3' is in the output";; *) PASS=$((PASS+1)); [ -n "${QUIET:-}" ] || echo "  pass  $1";; esac; }
run()   { OUT="$(node "$GATE" "$@" 2>&1)"; RC=$?; LAST="$(printf '%s\n' "$OUT" | tail -1)"; }

# ── the made-up private values, built from pieces ──────────────────────────
D=".";  A="@"
TERM_WHOLE="ops1";            TERM_ANY="acmecorp";        TERM_PATH="harborview"
IP4="8${D}8${D}4${D}4";       C=":"; IP6="2a01${C}4f8${C}c0c${C}1234${C}${C}1"
HOST="widgets-harbor${D}com"; MAIL="owner${A}harbor-mail${D}net"
PROJECT="abcdefghijklmnopqrst${D}supabase${D}co"
HEX="$(printf '%s' 0123456789abcdef 0123456789abcdef)"
UUID="0f8fad5b-d9cb""-469f-a165-70867728950e"
JWT="eyJ""hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9${D}eyJ""zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvIn0${D}sig"
KEYHEAD="-----BEGIN ""PRIVATE KEY-----"
FPR="SHA""256:Zx3Ab1+Cd2/Ef3gHi4jKl5mNo6pQr7sTu8vWx9yQ7mP"
FPRMD5="$(printf '%s:' 1a 2b 3c 4d 5e 6f 70 81 92 a3 b4 c5 d6 e7 f8)09"
PUBKEY="ssh-ed""25519 AAAA""C3NzaC1lZDI1NTE5AAAAIJ8kq2Lm4Zt6Yw1Vx3Ua5Sd7Rf9Qe0Pc2Nb4Mh6Kg8"
KEYBODY="MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"

DENY="$T/deny"; printf '%s\n' "# a test list" "$TERM_WHOLE" "~$TERM_ANY" "$TERM_PATH" "ab" > "$DENY"
OWNER="Copyright (c) 2026 Acmecorp Studio, LLC"   # a deliberate public mention of a listed name
ALLOW="$T/allow"; printf '%s\n' "# public names" "vendor-docs${D}com" "=only-this${D}io" "192${D}0${D}66${D}0/24" "in NOTICE: $OWNER" > "$ALLOW"

clean_tree() {  # a tree of made-up values only: every one must pass
  rm -rf "$T/tree"; mkdir -p "$T/tree/src" "$T/tree/docs"
  cat > "$T/tree/src/app.ts" <<EOF
const server = "203${D}0${D}113${D}9";   // a documentation address
const six = "2001:db8::1"; const local = "10${D}0${D}0${D}5"; const loop = "::1";
const site = "shop${D}example${D}com"; const mail = "admin${A}example${D}org";
const vendor = "https://api${D}vendor-docs${D}com/v1"; const one = "only-this${D}io";
const allowedNet = "192${D}0${D}66${D}7";
const fakeHex = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const fakeId = "00000000-0000-0000-0000-000000000000";
const longer = "${TERM_WHOLE}2 is another word"; const version = "1${D}2${D}3";
const row = { site: 1 }; console.info(row.site, document.title);
EOF
  printf '%s\n' "# Notes" "The key header alone is only text: $KEYHEAD" "" "Nothing else." > "$T/tree/docs/notes.md"
  printf '%s\n' '{"resolved": "https://registry'"${D}"'somewhere-else'"${D}"'com/pkg.tgz", "integrity": "'"$HEX"'", "author": "dev'"${A}"'somewhere-else'"${D}"'com"}' > "$T/tree/package-lock.json"
  printf '\x89PNG\x00\x00binary %s' "$IP4" > "$T/tree/docs/shot.png"
}
plant() { clean_tree; mkdir -p "$T/tree/$(dirname "$1")"; printf '%s\n' "a first line" "$2" >> "$T/tree/$1"; }
gate()  { run --tree "$T/tree" --denylist "$DENY" --allowlist "$ALLOW" "$@"; }

checks() {
  echo "A tree of made-up values only:"
  clean_tree; gate
  ok "ends clean, exit 0" "$LAST/$RC" "privacy_gate=clean/0"
  has "says how much it looked at" "$OUT" "looked at 3 text files"
  has "and what it left unread" "$OUT" "1 binary files left unread"
  has "and how many terms it had" "$OUT" "3 of your own terms"

  echo "One planted value of each kind (each alone in an otherwise clean tree):"
  one() {  # name, file, planted line, wanted kind, wanted match
    plant "$2" "$3"; gate
    ok "$1: ends findings, exit 1" "$LAST/$RC" "privacy_gate=findings/1"
    has "$1: named with its file, line and kind" "$OUT" "$2:2  $4  $5"
    has "$1: counted once" "$OUT" "1 finding(s) in 1 file(s): 1 $4"
  }
  one "your own term"            src/a.ts   "host $TERM_WHOLE is down"            your-term        "$TERM_WHOLE"
  one "your term, other case"    src/a.ts   "host OPS1 is down"                   your-term        "OPS1"
  one "a match-anywhere term"    src/a.ts   "const x = my${TERM_ANY}Client"       your-term        "$TERM_ANY"
  one "a public IPv4 address"    src/a.sh   "ssh root${A}$IP4"                    ip-address       "$IP4"
  one "a public IPv6 address"    src/a.sh   "allow $IP6"                          ip-address       "$IP6"
  one "a hostname"               src/a.md   "see https://$HOST/page"              hostname         "$HOST"
  one "an email address"         src/a.md   "write to <$MAIL>"                    email-address    "$MAIL"
  one "a database project"       src/a.ts   "url: \"https://$PROJECT\""           project-address  "$PROJECT"
  one "a long hex id"            src/a.ts   "aud: \"$HEX\""                       long-hex         "$HEX"
  one "a random UUID"            src/a.ts   "id: \"$UUID\""                       uuid             "$UUID"
  one "a signed token"           src/a.ts   "key: \"$JWT\""                       token            "${JWT:0:40}"
  one "an SSH key's fingerprint"  src/a.sh   "KEY_FP=\"$FPR\""                    key-fingerprint  "$FPR"
  one "an older-style fingerprint" src/a.md  "the key is $FPRMD5"                  key-fingerprint  "$FPRMD5"
  one "an SSH public key"        src/a.md   "$PUBKEY me"                          key-fingerprint  "$PUBKEY"
  one "a hostname with no scheme" src/a.md   "the box at $HOST answers"            hostname         "$HOST"

  echo "A private key (header with key material under it):"
  clean_tree; printf '%s\n' "$KEYHEAD" "$KEYBODY" > "$T/tree/src/key.pem"; gate
  ok "ends findings" "$LAST/$RC" "privacy_gate=findings/1"
  has "named as a private key" "$OUT" "src/key.pem:1  token  a private key"

  echo "A private name in a file's path:"
  clean_tree; mkdir -p "$T/tree/clients/$TERM_PATH"; echo "nothing private inside" > "$T/tree/clients/$TERM_PATH/notes.md"; gate
  ok "ends findings" "$LAST/$RC" "privacy_gate=findings/1"
  has "named as a term in a path" "$OUT" "clients/$TERM_PATH/notes.md  your-term-in-a-path  $TERM_PATH"

  echo "What must NOT be flagged:"
  plant src/a.ts "host ${TERM_WHOLE}2 and x${TERM_WHOLE} are other words"; gate
  ok "a term inside a longer word" "$LAST/$RC" "privacy_gate=clean/0"
  plant src/a.ts "sub${D}only-this${D}io"; gate
  ok "control: =host allows that one name, not its subdomains" "$LAST/$RC" "privacy_gate=findings/1"
  plant src/a.ts "deep${D}api${D}vendor-docs${D}com"; gate
  ok "a subdomain of an allowed host" "$LAST/$RC" "privacy_gate=clean/0"
  plant src/a.ts "import x from \"components/panel${D}io\"; fetch(\"/api/list${D}dev\")"; gate
  ok "a file name after a slash is a path, not a host" "$LAST/$RC" "privacy_gate=clean/0"
  plant src/a.ts "[\":bad_querystring_10${C}${C}bad_request_15:\"] 203${D}0${D}113${D}55"; gate
  ok "a 7G log's joined rule names are not an IPv6 address" "$LAST/$RC" "privacy_gate=clean/0"
  plant src/a.sh "allow=$IP6"; gate
  ok "control: an IPv6 address after = is still one" "$LAST/$RC" "privacy_gate=findings/1"
  plant package-lock.json "\"url\": \"https://$HOST/x\", \"sha\": \"$HEX\""; gate
  ok "a lock file's hostnames and checksums" "$LAST/$RC" "privacy_gate=clean/0"
  plant package-lock.json "\"note\": \"$TERM_WHOLE\""; gate
  ok "control: your own term in a lock file is still found" "$LAST/$RC" "privacy_gate=findings/1"
  plant src/a.sh "KEY_FP=\"\${KEY_FP:-SHA""256:}\"; echo SHA""256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; gate
  ok "the bare SHA256 label, and a placeholder of one repeated letter" "$LAST/$RC" "privacy_gate=clean/0"
  plant src/a.ts "ab is two letters and on the list"; gate
  ok "a list term shorter than three characters is ignored" "$LAST/$RC" "privacy_gate=clean/0"

  echo "One exact text permitted in one named file:"
  clean_tree; printf '%s\n' "The licence" "$OWNER" "All rights as stated." > "$T/tree/NOTICE"; gate
  ok "the permitted text in its own file: clean" "$LAST/$RC" "privacy_gate=clean/0"
  has "and it is counted" "$OUT" "1 permitted texts"
  clean_tree; printf '%s\n' "$OWNER" > "$T/tree/src/credits.md"; gate
  ok "control: the same text in another file is a finding" "$LAST/$RC" "privacy_gate=findings/1"
  has "named there" "$OUT" "src/credits.md:1  your-term  Acmecorp"
  clean_tree; printf '%s\n' "$OWNER and the $TERM_ANY team" > "$T/tree/NOTICE"; gate
  ok "control: more of the name on the same line is still a finding" "$LAST/$RC" "privacy_gate=findings/1"
  has "counted once, not twice" "$OUT" "1 finding(s) in 1 file(s): 1 your-term"
  clean_tree; printf '%s\n' "copyright (c) 2026 acmecorp studio, llc" > "$T/tree/NOTICE"; gate
  ok "control: the text in other letters is not the permitted text" "$LAST/$RC" "privacy_gate=findings/1"
  clean_tree; mkdir -p "$T/tree/scripts"; cp "$ALLOW" "$T/tree/scripts/privacy-allowlist.txt"; printf '%s\n' "$OWNER" > "$T/tree/NOTICE"
  run --tree "$T/tree" --denylist "$DENY" --allowlist "$T/tree/scripts/privacy-allowlist.txt"
  ok "the allowlist's own line that declares it: clean" "$LAST/$RC" "privacy_gate=clean/0"
  printf '%s\n' "# also thanks to $TERM_ANY" >> "$T/tree/scripts/privacy-allowlist.txt"; run --tree "$T/tree" --denylist "$DENY" --allowlist "$T/tree/scripts/privacy-allowlist.txt"
  ok "control: the name elsewhere in the allowlist file is a finding" "$LAST/$RC" "privacy_gate=findings/1"

  echo "The built-in checks alone (what CI runs, with no list):"
  plant src/a.sh "ssh root${A}$IP4"; run --tree "$T/tree" --allowlist "$ALLOW" --generic-only
  ok "an address is still found" "$LAST/$RC" "privacy_gate=findings/1"
  has "and it says no list was used" "$OUT" "built-in checks only, no denylist"
  plant src/a.ts "host $TERM_WHOLE is down"; run --tree "$T/tree" --allowlist "$ALLOW" --generic-only
  ok "your own term is not (it has no list): clean" "$LAST/$RC" "privacy_gate=clean/0"

  echo "Could not look is never a pass:"
  clean_tree; run --tree "$T/tree" --denylist "$T/no-such-list" --allowlist "$ALLOW"
  ok "no denylist: blind, exit 3" "$LAST/$RC" "privacy_gate=blind/3"
  has "and it says how to make one" "$OUT" "npm run privacy:denylist"
  printf '%s\n' "# only a comment" "ab" > "$T/empty-deny"; run --tree "$T/tree" --denylist "$T/empty-deny" --allowlist "$ALLOW"
  ok "a denylist with no usable terms: blind, exit 3" "$LAST/$RC" "privacy_gate=blind/3"
  mkdir -p "$T/void"; run --tree "$T/void" --denylist "$DENY"
  ok "an empty folder: blind, exit 3" "$LAST/$RC" "privacy_gate=blind/3"
  mkdir -p "$T/onlybin"; printf '\x89PNG\x00\x00' > "$T/onlybin/a.png"; run --tree "$T/onlybin" --denylist "$DENY"
  ok "a folder of images only: blind, exit 3" "$LAST/$RC" "privacy_gate=blind/3"
  run --tree "$T/no-such-folder" --denylist "$DENY"
  ok "no such folder: blind, exit 3" "$LAST/$RC" "privacy_gate=blind/3"
  run --tree "$T/tree" --denylist "$DENY" --surprise
  ok "an unknown option: usage, exit 2" "$LAST/$RC" "privacy_gate=blind/2"
  run --tree
  ok "an option with no value: usage, exit 2" "$LAST/$RC" "privacy_gate=blind/2"

  echo "The findings file:"
  plant src/a.sh "ssh root${A}$IP4 and $TERM_WHOLE"; gate --json "$T/out.json" --quiet
  ok "quiet still ends with the verdict" "$LAST/$RC" "privacy_gate=findings/1"
  hasnt "quiet prints no finding lines" "$OUT" "src/a.sh:2"
  ok "the file holds both findings and the counts" "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.findings.length, j.scanned, j.terms, j.kinds["ip-address"], j.kinds["your-term"])' "$T/out.json")" "2 4 3 1 1"
}

if [ "${1:-}" = "--controls" ]; then
  # Break the gate one way at a time; the checks above must notice every break.
  echo "Controls: each broken copy of the gate must fail at least one check."
  BASE="$(QUIET=1 bash "$0" 2>&1 | tail -1)"
  case "$BASE" in *" 0 failed"*) ;; *) echo "The checks do not pass on the gate as it is ($BASE), so a control would prove nothing. Fix that first."; exit 1;; esac
  CAUGHT=0; MISSED=0
  try() {  # name, a node expression that edits the source text `s`
    local copy="$T/broken-gate.mjs"
    node -e 'const fs=require("fs");let s=fs.readFileSync(process.argv[1],"utf8");const before=s;s=eval(process.argv[3]);if(s===before){console.error("the edit changed nothing");process.exit(9)}fs.writeFileSync(process.argv[2],s)' "$GATE" "$copy" "$2" || { MISSED=$((MISSED+1)); echo "  MISSED  $1 (the control itself did not apply)"; return; }
    cp "$HERE/privacy-allowlist.txt" "$T/privacy-allowlist.txt" 2>/dev/null
    local out; out="$(FLEET_GATE_UNDER_TEST="$copy" QUIET=1 bash "$0" 2>&1 | tail -1)"
    case "$out" in *" 0 failed"*) MISSED=$((MISSED+1)); echo "  MISSED  $1";; *) CAUGHT=$((CAUGHT+1)); echo "  caught  $1";; esac
  }
  try "findings still exit 0"                     's.replace("findings.length ? 1 : 0", "0")'
  try "findings are called clean"                 's.replace("end(findings.length ? \"findings\" : \"clean\"", "end(findings.length ? \"clean\" : \"clean\"")'
  try "a missing denylist is treated as none"     's.replace("if (!existsSync(denyFile)) {", "if (false) {")'
  try "an empty tree is called clean"             's.replace("if (scanned === 0) {", "if (false) {")'
  try "your own terms are never matched"          's.replace("if (wholeRe) for (const m of row.matchAll(wholeRe))", "if (false) for (const m of row.matchAll(wholeRe))")'
  try "match-anywhere terms are never matched"    's.replace("if (anyRe) for (const m of row.matchAll(anyRe))", "if (false) for (const m of row.matchAll(anyRe))")'
  try "terms match inside longer words"           's.replace("(?<![a-z0-9])(?:${whole", "(?:${whole").replace(".join(\"|\")})(?![a-z0-9])`", ".join(\"|\")})`")'
  try "term matching is case-sensitive"           's.replace("(?![a-z0-9])`, \"gi\")", "(?![a-z0-9])`, \"g\")")'
  try "paths are not looked at"                   's.replace("for (const re of [wholeRe, anyRe]) if (re) {", "for (const re of []) if (re) {")'
  try "every IPv4 address is called safe"         's.replace("const safe4 = (a) =>", "const safe4 = (a) => true ||")'
  try "every IPv6 address is called safe"         's.replace("const safe6 = (a) => {", "const safe6 = (a) => { return true;")'
  try "IPv6 matched right after a letter or _"   's.replace("re: /(?<![0-9a-z_:.])(?:[0-9a-f]{0,4}:)", "re: /(?<![0-9a-f:.])(?:[0-9a-f]{0,4}:)")'
  try "every hostname is allowed"                 's.replace("const hostAllowed = (h) =>", "const hostAllowed = (h) => true ||")'
  try "=host also allows subdomains"              's.replace("const allowHosts = allow.filter((a) => !a.startsWith(\"=\") &&", "const allowHosts = allow.map((a) => a.replace(/^=/, \"\")).filter((a) =>")'
  try "project addresses are not checked"         's.replace("kind: \"project-address\", re: /[a-z]{20}", "kind: \"project-address\", re: /[a-z]{99}")'
  try "long hex is never flagged"                 's.replace("bad: (m) => distinct(m) > 6", "bad: (m) => distinct(m) > 99")'
  try "UUIDs are never flagged"                   's.replace("bad: (m) => distinct(m) > 8", "bad: (m) => distinct(m) > 99")'
  try "tokens are never flagged"                  's.replace("bad: (m) => !/fake|example|not-a-real/i.test(m)", "bad: () => false")'
  try "key fingerprints are never flagged"        's.replace("bad: (m) => new Set(m.slice(7)).size > 8", "bad: (m) => false")'
  try "older-style fingerprints are not checked"  's.replace("(?:[0-9a-f]{2}:){15}", "(?:[0-9a-f]{2}:){99}")'
  try "public keys are not checked"               's.replace("AAAA[A-Za-z0-9+/]{40,}={0,2}/g, bad: () => true", "AAAA[A-Za-z0-9+/]{40,}={0,2}/g, bad: () => false")'
  try "a private key is not noticed"              's.replace("add(file, i + 1, \"token\", \"a private key\")", "void 0")'
  try "lock files are skipped for your terms too" 's.replace("if (wholeRe) for (const m of row.matchAll(wholeRe))", "if (wholeRe && !LOCKFILE.test(file)) for (const m of row.matchAll(wholeRe))")'
  try "two-letter terms are kept"                 's.replace(".filter((t) => t.replace(/^~/, \"\").length >= 3)", "")'
  try "binary files are read as text"             's.replace("if (BINARY.test(file)) { binary++; continue; }", "").replace("if (text.includes(\"\\u0000\")) { binary++; continue; }", "")'
  try "an unknown option is ignored"              's.replace("if (!KNOWN.has(args[i])) {", "if (false) {")'
  try "a permitted text is permitted in every file"   's.replace("(allowedText.get(file) || [])", "[...allowedText.values()].flat()")'
  try "a permitted text is never blanked"            's.replace("for (const text of permitted) row = row.split(text).join(\" \".repeat(text.length));", "")'
  try "a permitted text blanks its whole line"       's.replace("row = row.split(text).join(\" \".repeat(text.length));", "if (row.includes(text)) row = \"\";")'
  try "the allowlist file is never checked"          's.replace("const permitted = file === allowFileRel ? ", "if (file === allowFileRel) continue; const permitted = false ? ")'
  try "the built-in checks are skipped"           's.replace("for (const c of CHECKS) {", "for (const c of []) {")'
  echo "controls: $CAUGHT caught, $MISSED missed, of $((CAUGHT+MISSED))"
  [ "$MISSED" = 0 ] || exit 1
  exit 0
fi

checks
echo "privacy gate: $((PASS+FAIL)) checks, $FAIL failed"
[ "$FAIL" = 0 ]
