#!/bin/bash
# ==============================================================================
# Shared SSH plumbing for the fleet scripts
# ==============================================================================
# Sourced by fix-telemetry-crontabs.sh, install-7g-logrotate.sh and
# install-operator-allowlist.sh. Not executable on its own.
#
# It exists for ONE reason: a single transient TCP timeout should not silently
# drop a server from a mutating run across every server. A healthy box can miss
# a run that way, and finding which servers were skipped means auditing them all.
#
# WHY THIS IS SHARED RATHER THAN COPY-PASTED: the retry predicate below is
# safety logic guarding root-level mutations on production servers. Three
# copies of it is how one of them quietly drifts into retrying something it
# must not.
# ==============================================================================

# What a refused host key looks like, and what to tell the person at the
# keyboard, are written once, in lib-fleet-hostkeys.sh.
# shellcheck source=lib-fleet-hostkeys.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-fleet-hostkeys.sh" || return 1   # host-keys

# ------------------------------------------------------------------------------
# Is this failure safe to retry?
#
# THE RULE: retry only where the remote command PROVABLY NEVER EXECUTED. These
# scripts write crontabs, replace agents and rewrite logrotate rules as root. A
# retry that re-runs a half-completed command is far worse than a missed server,
# so anything ambiguous is treated as non-retryable by design.
#
# $1 = path to the captured stderr file, $2 = ssh exit code
# ------------------------------------------------------------------------------
fleet_ssh_is_transient() {
    local errf="$1" rc="$2"

    # 255 is ssh's OWN error code. Any other code came from the remote command,
    # which means it ran — never retry that.
    [ "$rc" = "255" ] || return 1
    [ -s "$errf" ] || return 1

    # A server that answers with another host key is never tried again: ssh
    # refused before any command ran, and it would refuse the same key twice.
    fleet_hostkey_is_refusal "$errf" && return 1   # host-keys

    # Explicit refusals first. These are terminal, and retrying an auth failure
    # only doubles the lockout risk against Fail2Ban's sshd jail.
    if grep -qiE 'permission denied|host key verification failed|too many authentication failures|no matching host key' "$errf"; then
        return 1
    fi

    # Connect- and handshake-level failures. In every case below the TCP session
    # never carried a command, so re-running cannot double-apply anything.
    #
    # NOT in this list, deliberately: "Connection closed by remote host". That
    # one can fire mid-command as well as pre-auth, and the two are
    # indistinguishable from here. Missing a server beats corrupting one.
    grep -qiE 'operation timed out|connection timed out|connection refused|no route to host|network is unreachable|host is unreachable|host is down|kex_exchange_identification' "$errf"
}

# ------------------------------------------------------------------------------
# Quote a string so the REMOTE shell receives it as exactly one argument.
#
# ssh does NOT pass an argument vector. It joins everything into one command
# string that the remote shell re-splits on whitespace, so local quoting buys
# nothing. `ssh host 'bash -s' "$A" "$B"` with A="first arg" arrives as three
# parameters, not two. That silently truncates a multi-address allowlist
# apply — hence a function rather than trusting quoting.
# ------------------------------------------------------------------------------
fleet_ssh_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# ------------------------------------------------------------------------------
# Run a script on a remote host, retrying once on a connect-level failure.
#
#   fleet_ssh <ip> <script-text> [args...]
#   OUT="$FLEET_SSH_OUT"
#
# CALL IT WITHOUT COMMAND SUBSTITUTION. Results come back in globals, not on
# stdout, because `OUT=$(fleet_ssh ...)` would run the whole thing in a subshell
# and every global set below would be discarded — the caller would then read a
# STALE FLEET_SSH_RC from the previous server and report nonsense. (The first
# draft did exactly this and reported rc=255 on a successful call.)
#
# The remote program is fed through stdin to `bash -s`, as the heredoc form did.
# It is a STRING rather than a heredoc because a heredoc is consumed once, so
# the call could not be repeated — which is the whole point of this function.
#
# Do NOT add `ssh -n`: it points stdin at /dev/null, and `bash -s` reads the
# remote program FROM stdin. With it, every server reports
# UNREACHABLE. (`ssh -n` is for `while read` loops, where ssh would otherwise
# eat the loop's input; these loops iterate a variable.)
#
# Sets: FLEET_SSH_OUT, FLEET_SSH_RC, FLEET_SSH_ERR, FLEET_SSH_ATTEMPTS.
# ------------------------------------------------------------------------------
fleet_ssh() {
    local ip="$1" script="$2"; shift 2
    local errf rc attempt a qargs=""

    for a in "$@"; do qargs="$qargs $(fleet_ssh_quote "$a")"; done

    errf=$(mktemp)
    FLEET_SSH_OUT=""
    FLEET_SSH_ATTEMPTS=0

    for attempt in 1 2; do
        FLEET_SSH_ATTEMPTS=$attempt
        : > "$errf"
        # shellcheck disable=SC2086  # SSH_OPTS is intentionally word-split
        FLEET_SSH_OUT=$(printf '%s' "$script" | ssh $SSH_OPTS "root@$ip" "bash -s$qargs" 2>"$errf")
        rc=$?

        # Anything on stdout means the remote ran. Never retry past that point.
        [ -n "$FLEET_SSH_OUT" ] && break

        if [ "$attempt" = "1" ] && fleet_ssh_is_transient "$errf" "$rc"; then
            echo "   … connect failed, retrying once: $(head -1 "$errf" | sed 's/^[[:space:]]*//')"
            sleep 3
            continue
        fi
        break
    done

    # A refused host key is said here, in plain words and with the way out, so
    # every caller says it whatever it prints next.
    fleet_hostkey_refusal "$errf" "$ip" || true   # host-keys

    FLEET_SSH_RC=$rc
    FLEET_SSH_ERR=$(cat "$errf")
    rm -f "$errf"
}

# ------------------------------------------------------------------------------
# Report a failed call. Says what actually happened rather than guessing at
# 1Password: a catch-all message naming one cause sends the diagnosis in the
# wrong direction when the script's own first line has already confirmed the
# key was loaded with no prompts needed.
# ------------------------------------------------------------------------------
fleet_ssh_report_failure() {
    echo "   NO OUTPUT — ssh exit $FLEET_SSH_RC (after $FLEET_SSH_ATTEMPTS attempt(s))"
    if [ -n "$FLEET_SSH_ERR" ]; then
        # Strip ssh's own "ssh: " prefix before adding ours, or the line reads
        # "ssh: ssh: connect to host ...".
        printf '%s\n' "$FLEET_SSH_ERR" | head -5 | sed -e 's/^ssh: //' -e 's/^/   ssh: /'
    else
        echo "   ssh: (no stderr — the remote ran but printed nothing)"
    fi
}
