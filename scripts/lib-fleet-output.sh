#!/bin/bash
# ==============================================================================
# The output folder: where runs, audits and snapshots are kept on this machine
# ==============================================================================
# Sourced by waf-refresh.sh, fleet-fail2ban.sh, fleet-fail2ban-apply.sh,
# fleet-server-snapshot.sh and fleet-server-restore.sh. Not executable on its
# own. It sets nothing and runs nothing when sourced: it only defines the
# functions below.
#
#   fleet_output_dir         prints the folder. It is the first of these that is set:
#       1. the environment variable FLEET_OUTPUT_DIR
#       2. the full path on one line in ~/.config/fleet/output-dir
#          (under $XDG_CONFIG_HOME when that is set)
#       3. ~/.local/state/fleet        (under $XDG_STATE_HOME when that is set)
#
#   fleet_output_dir_hint    prints what to tell someone when a lookup in that
#                            folder found nothing: the folder that was searched,
#                            which of the three it came from, and how to point at
#                            another one.
#
# The folder is not created here, and nothing is ever looked for in a folder
# that is not one of those three: if earlier runs are kept somewhere else, the
# setting is how a script is told.
#
# scripts/ingest-waf-report.ts finds the same folder in TypeScript (outputDir).
# Change one, change both: scripts/test-waf-inventory.py runs the two side by
# side on the same made-up settings and fails if they disagree.
# ==============================================================================

# The settings file a folder can be named in.
fleet_output_dir_file() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/output-dir"; }

fleet_output_dir() {
    local dir="${FLEET_OUTPUT_DIR:-}"
    [ -n "$dir" ] || dir="$(cat "$(fleet_output_dir_file)" 2>/dev/null)"
    [ -n "$dir" ] || dir="${XDG_STATE_HOME:-$HOME/.local/state}/fleet"
    printf '%s' "$dir"
}

fleet_output_dir_hint() {
    local from="the default: no other folder is set"
    if [ -n "${FLEET_OUTPUT_DIR:-}" ]; then
        from="set in FLEET_OUTPUT_DIR"
    elif [ -n "$(cat "$(fleet_output_dir_file)" 2>/dev/null)" ]; then
        from="set in $(fleet_output_dir_file)"
    fi
    echo "       Folder searched: $(fleet_output_dir)"
    echo "       ($from)"
    echo "       If earlier runs, audits or snapshots are kept in another folder, point at it:"
    echo "       set FLEET_OUTPUT_DIR, or put its full path on one line in $(fleet_output_dir_file)."
}
