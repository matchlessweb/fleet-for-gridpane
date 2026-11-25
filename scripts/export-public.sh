#!/usr/bin/env bash
# Makes the public copy of this repository: the last commit's files, minus what
# scripts/export-public.rules leaves out, checked by the privacy gate, in a NEW
# folder with no history. It never pushes and never adds a remote: publishing
# is a step you take yourself, after reading what it made.
#
#   bash scripts/export-public.sh --check
#       Export to a temporary folder, run the gate, say the verdict, remove the folder.
#   bash scripts/export-public.sh --check --from-disk
#       The same, from the tracked files as they are on disk (work not yet committed).
#   bash scripts/export-public.sh ../fleet-public
#       Export the last commit into a new folder and run the gate. No repository is made.
#   bash scripts/export-public.sh ../fleet-public --commit --name "Your Name" --email "you@example.com"
#       The same, then start a repository there with one commit that carries that name and address.
#
# Options: --source <checkout> (default: the checkout this script is in), --rules <file>,
# --denylist <file> (default: $FLEET_PRIVACY_DENYLIST, else ~/.config/fleet/privacy-denylist),
# --message <text> for the commit, --no-gate-test (skip the gate's own test; --commit refuses it).
#
# The gate runs WITH your denylist, always. Without one this stops: a copy that
# was never checked against your own names is not a checked copy.
#
# Exit 0: exported and clean.  1: the gate found something, or a step failed.
# 2: wrong usage.  3: it could not look. The last line is always
# `export_public=clean|findings|blind|failed`.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
finish() { echo "export_public=$1"; exit "$2"; }
usage()  { echo "$1" >&2; echo "See the top of scripts/export-public.sh for how to run it." >&2; finish failed 2; }

CHECK=0; FROM_DISK=0; COMMIT=0; GATE_TEST=1
TARGET=""; SOURCE=""; RULES=""; DENY=""; NAME=""; EMAIL=""; MESSAGE="Fleet: first public release"
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1;; --from-disk) FROM_DISK=1;; --commit) COMMIT=1;; --no-gate-test) GATE_TEST=0;;
    --source|--rules|--denylist|--name|--email|--message)
      [ $# -ge 2 ] && [ -n "$2" ] || usage "$1 needs a value."
      case "$1" in --source) SOURCE="$2";; --rules) RULES="$2";; --denylist) DENY="$2";; --name) NAME="$2";; --email) EMAIL="$2";; --message) MESSAGE="$2";; esac
      shift;;
    --*) usage "Unknown option: $1";;
    *) [ -z "$TARGET" ] || usage "Only one folder can be named (got '$TARGET' and '$1')."; TARGET="$1";;
  esac
  shift
done
[ "$CHECK" = 1 ] && [ -n "$TARGET" ] && usage "--check uses a temporary folder: leave the folder out, or leave --check out."
[ "$CHECK" = 0 ] && [ -z "$TARGET" ] && usage "Name a new folder to export into, or pass --check."
[ "$FROM_DISK" = 1 ] && [ "$CHECK" = 0 ] && usage "--from-disk is for --check only: a real export is made from a commit."
[ "$COMMIT" = 1 ] && [ "$CHECK" = 1 ] && usage "--commit needs a folder to keep, so it cannot go with --check."
[ "$COMMIT" = 1 ] && [ "$GATE_TEST" = 0 ] && usage "--commit will not skip the gate's own test."
if [ "$COMMIT" = 1 ]; then
  [ -n "$NAME" ] && [ -n "$EMAIL" ] || usage "--commit needs --name and --email: they are published with the commit, so they are typed, never guessed from this machine."
  case "$EMAIL" in *@*.*) ;; *) usage "--email does not look like an address: $EMAIL";; esac
fi

SOURCE="$(cd "${SOURCE:-$HERE/..}" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)" || { echo "Not a git checkout: ${SOURCE:-$HERE/..}" >&2; finish blind 3; }
RULES="${RULES:-$SOURCE/scripts/export-public.rules}"
[ -f "$RULES" ] || { echo "No rules file at $RULES" >&2; finish blind 3; }
GATE="$SOURCE/scripts/privacy-gate.mjs"
[ -f "$GATE" ] || { echo "No privacy gate at $GATE" >&2; finish blind 3; }
DENY="${DENY:-${FLEET_PRIVACY_DENYLIST:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/privacy-denylist}}"
if [ ! -f "$DENY" ]; then
  echo "No denylist at $DENY." >&2
  echo "Make one with: npm run privacy:denylist   This export is never checked without it." >&2
  finish blind 3
fi
# A list made before your newest server or site was added does not know its name.
AGE_DAYS=$(( ( $(date +%s) - $(stat -f %m "$DENY" 2>/dev/null || stat -c %Y "$DENY") ) / 86400 ))
if [ "$AGE_DAYS" -ge 7 ] && [ "$COMMIT" = 1 ]; then
  echo "The denylist is $AGE_DAYS days old. Run: npm run privacy:denylist   then export again." >&2
  finish blind 3
fi

if [ "$CHECK" = 1 ]; then
  OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
else
  case "$TARGET" in /*) ;; *) TARGET="$PWD/$TARGET";; esac
  if [ -e "$TARGET" ]; then
    [ -d "$TARGET" ] && [ -z "$(ls -A "$TARGET")" ] || { echo "$TARGET exists and is not an empty folder. Name a new folder." >&2; finish failed 1; }
  else
    mkdir -p "$TARGET" || finish failed 1
  fi
  OUT="$(cd "$TARGET" && pwd -P)"
  case "$OUT/" in "$(cd "$SOURCE" && pwd -P)"/*) rmdir "$OUT" 2>/dev/null; echo "The folder must be outside the checkout ($SOURCE)." >&2; finish failed 1;; esac
fi

# ── 1. copy ──────────────────────────────────────────────────────────────────
if [ "$FROM_DISK" = 1 ]; then
  FROM="the tracked files as they are on disk (not a commit)"
  COPIED=0
  while IFS= read -r -d '' f; do
    [ -e "$SOURCE/$f" ] || continue
    mkdir -p "$OUT/$(dirname "$f")" && cp -pR "$SOURCE/$f" "$OUT/$f" || { echo "Could not copy $f" >&2; finish failed 1; }
    COPIED=$((COPIED+1))
  done < <(git -C "$SOURCE" ls-files -z)
else
  SHA="$(git -C "$SOURCE" rev-parse --short HEAD)" || finish failed 1
  FROM="commit $SHA"
  [ -z "$(git -C "$SOURCE" status --porcelain --untracked-files=no)" ] || echo "Note: this checkout has changes that are not committed. They are NOT in the export."
  git -C "$SOURCE" archive HEAD | tar -x -C "$OUT" || { echo "Could not copy the commit's files." >&2; finish failed 1; }
  COPIED="$(git -C "$SOURCE" ls-tree -r --name-only HEAD | wc -l | tr -d ' ')"
fi
[ "$COPIED" -gt 0 ] || { echo "Nothing to export." >&2; finish blind 3; }

# ── 2. the rules ─────────────────────────────────────────────────────────────
DROPPED=0; USED=0; CUT=0; SCRIPTS=0; N=0
safe() { case "$1" in ""|/*|*..*) return 1;; esac; return 0; }
while IFS= read -r line || [ -n "$line" ]; do
  N=$((N+1))
  line="${line%%#*}"; set -- $line
  [ $# -gt 0 ] || continue
  case "$1" in
    drop)
      [ $# = 2 ] && safe "$2" || { echo "$RULES:$N: write it as: drop <path inside the repository>" >&2; finish failed 1; }
      if [ -e "$OUT/$2" ] || [ -L "$OUT/$2" ]; then rm -rf "${OUT:?}/$2"; DROPPED=$((DROPPED+1)); else echo "Note: $RULES:$N drops $2, which is not there."; fi;;
    use)
      [ $# = 4 ] && [ "$3" = as ] && safe "$2" && safe "$4" || { echo "$RULES:$N: write it as: use <example file> as <path>" >&2; finish failed 1; }
      [ -f "$OUT/$2" ] || { echo "$RULES:$N: the example $2 is not in the export, so $4 would be missing or private. Stopping." >&2; finish failed 1; }
      # The path may be in a folder your own repository does not have (a workflow GitHub would run).
      mkdir -p "$(dirname "$OUT/$4")" && cp "$OUT/$2" "$OUT/$4" || finish failed 1; USED=$((USED+1));;
    cut)
      [ $# = 3 ] && safe "$2" || { echo "$RULES:$N: write it as: cut <path> <marker>" >&2; finish failed 1; }
      if [ -f "$OUT/$2" ]; then
        # From the line that holds BEGIN and the marker, through the line that holds END and the marker.
        awk -v m="$3" 'index($0,"BEGIN") && index($0,m) {skip=1; found++; next} skip && index($0,"END") && index($0,m) {skip=0; next} !skip {print} END {if (skip) exit 7; if (!found) exit 8}' "$OUT/$2" > "$OUT/$2.cut"; RC=$?
        if [ "$RC" = 7 ]; then rm -f "$OUT/$2.cut"; echo "$RULES:$N: $2 has a BEGIN line for '$3' with no END line. Stopping." >&2; finish failed 1; fi
        if [ "$RC" = 8 ]; then rm -f "$OUT/$2.cut"; echo "Note: $RULES:$N found no '$3' block in $2."; else mv "$OUT/$2.cut" "$OUT/$2"; CUT=$((CUT+1)); fi
      else echo "Note: $RULES:$N cuts from $2, which is not there."; fi;;
    drop-script)
      [ $# = 2 ] || { echo "$RULES:$N: write it as: drop-script <name of an npm script in package.json>" >&2; finish failed 1; }
      if [ -f "$OUT/package.json" ]; then
        # Removes one entry from "scripts" and keeps the file's own indentation. Exit 8: no such script.
        node -e 'const fs=require("fs"),f=process.argv[1],n=process.argv[2],t=fs.readFileSync(f,"utf8");const p=JSON.parse(t);if(!p.scripts||!Object.prototype.hasOwnProperty.call(p.scripts,n))process.exit(8);delete p.scripts[n];const ind=(t.match(/\n([ \t]+)"/)||[,"  "])[1];fs.writeFileSync(f,JSON.stringify(p,null,ind)+(t.endsWith("\n")?"\n":""))' "$OUT/package.json" "$2"; RC=$?
        case "$RC" in
          0) SCRIPTS=$((SCRIPTS+1));;
          8) echo "Note: $RULES:$N drops the npm script $2, which package.json does not have.";;
          *) echo "$RULES:$N: could not take the npm script $2 out of package.json. Stopping." >&2; finish failed 1;;
        esac
      else echo "Note: $RULES:$N drops an npm script, and there is no package.json."; fi;;
    *) echo "$RULES:$N: unknown rule '$1' (drop, use … as …, cut, drop-script)." >&2; finish failed 1;;
  esac
done < "$RULES"
LEFT="$(find "$OUT" -type f | wc -l | tr -d ' ')"
echo "Exported $FROM: $COPIED files copied, $DROPPED left out, $USED replaced by their example, $CUT trimmed, $SCRIPTS npm scripts left out; $LEFT files in the export."

# A link that points outside the folder publishes a path from this machine.
LINKS="$(find "$OUT" -type l -lname '/*' | sed "s#^$OUT/##")"
if [ -n "$LINKS" ]; then echo "These links point to a path on this machine:"; echo "$LINKS" | sed 's/^/  /'; echo "Leave them out (a drop rule) or make them relative."; [ "$CHECK" = 1 ] || echo "NOT publishable: links to paths on this machine. See scripts/export-public.sh." > "$OUT/NOT-PUBLISHABLE.txt"; finish findings 1; fi

# ── 3. the gate ──────────────────────────────────────────────────────────────
if [ "$GATE_TEST" = 1 ] && [ "$CHECK" = 0 ]; then
  # A gate that cannot fail proves nothing: run its own test first.
  T="$(bash "$SOURCE/scripts/test-privacy-gate.sh" 2>&1 | tail -1)"
  case "$T" in *" 0 failed"*) echo "The gate's own test passes ($T).";; *) echo "The privacy gate's own test does not pass ($T), so its verdict would mean nothing. Stopping." >&2; echo "NOT publishable: the gate was not trusted. See scripts/export-public.sh." > "$OUT/NOT-PUBLISHABLE.txt"; finish blind 3;; esac
fi
[ "$AGE_DAYS" -ge 1 ] && echo "Note: the denylist is $AGE_DAYS day(s) old. If you have added a server or site since, run: npm run privacy:denylist"
ALLOW="$OUT/scripts/privacy-allowlist.txt"; [ -f "$ALLOW" ] || ALLOW="$SOURCE/scripts/privacy-allowlist.txt"
node "$GATE" --tree "$OUT" --denylist "$DENY" --allowlist "$ALLOW"; RC=$?
BIN="$(find "$OUT" -type f | grep -iE '\.(png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp4|mov|webm)$' | sed "s#^$OUT/##" | sort)"
if [ -n "$BIN" ]; then echo; echo "The gate cannot read these $(echo "$BIN" | wc -l | tr -d ' ') files. Look at each one yourself (a screenshot can show a client's name):"; echo "$BIN" | sed 's/^/  /'; fi
echo
case "$RC" in
  0) ;;
  1) echo "NOT publishable: the gate found the items listed above."
     [ "$CHECK" = 1 ] || { echo "NOT publishable: the privacy gate found private details in this folder. See scripts/export-public.sh." > "$OUT/NOT-PUBLISHABLE.txt"; echo "The folder is left at $OUT for you to look at, marked NOT-PUBLISHABLE.txt. No repository was made."; }
     finish findings 1;;
  *) echo "The gate could not look (exit $RC), so this export is not checked."
     [ "$CHECK" = 1 ] || echo "NOT publishable: the privacy gate could not run. See scripts/export-public.sh." > "$OUT/NOT-PUBLISHABLE.txt"
     finish blind 3;;
esac

if [ "$CHECK" = 1 ]; then echo "Clean. (The temporary folder is removed.)"; finish clean 0; fi
if [ "$COMMIT" = 0 ]; then
  echo "Clean. The export is at $OUT. No repository was made."
  echo "To make one, export again into another new folder with: --commit --name \"…\" --email \"…\""
  echo "(the name and address are published with the commit; GitHub offers a private noreply address under Settings > Emails)."
  finish clean 0
fi

# ── 4. one commit, no history, no remote ─────────────────────────────────────
echo "Starting a repository with one commit by: $NAME <$EMAIL>"
git init -q -b main "$OUT" && git -C "$OUT" add -A || { echo "Could not start the repository." >&2; finish failed 1; }
GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" git -C "$OUT" commit -q -m "$MESSAGE" || { echo "The commit was refused (see git's message above). The folder is left as it is, with no commit." >&2; finish failed 1; }
echo "Made: $(git -C "$OUT" log -1 --format='%h  author %an <%ae>  committer %cn <%ce>') ($(git -C "$OUT" ls-files | wc -l | tr -d ' ') files, $(git -C "$OUT" rev-list --count HEAD) commit)"
[ -z "$(git -C "$OUT" remote)" ] && echo "No remote was added and nothing was pushed. Read the folder, then publish it yourself."
finish clean 0
