#!/bin/bash
# ==============================================================================
# Host keys: a server must answer with the key it answered with the first time
# ==============================================================================
# Sourced by every script that connects to a server, and by lib-fleet-ssh.sh.
# Not executable on its own. It sets nothing and runs nothing when sourced: it
# only defines the functions below.
#
# THE RULE. The first time a script connects to an address, ssh saves that
# server's host key. Every later connection must be answered with the same key.
# If it is not, ssh refuses, nothing is run on that server, and the script says
# so and prints the command that forgets the old key. (ssh's name for this is
# StrictHostKeyChecking=accept-new.)
#
# The keys are kept in Fleet's own file. It is the first of these that is set:
#   1. the full path in the environment variable FLEET_KNOWN_HOSTS
#   2. ~/.config/fleet/known_hosts      (under $XDG_CONFIG_HOME when that is set)
# The file and its folder are made when they are missing: the folder for you
# alone (700), the file for you alone (600). Nothing is read from
# ~/.ssh/known_hosts and nothing is written to it.
#
#   fleet_known_hosts_file    prints the file's path.
#   fleet_hostkey_opts        makes the file if it is missing, then prints the
#                             two ssh options. If it cannot, it prints why on
#                             stderr and returns 1.
#   fleet_hostkey_is_refusal <file>
#                             true when the text in <file> (what ssh printed on
#                             stderr) says ssh refused over the host key.
#   fleet_hostkey_explain <address>
#                             says what happened and what to do next, with the
#                             exact command that forgets the old key.
#   fleet_hostkey_refusal <file> <address>
#                             the two together: on a refusal it explains and
#                             returns 0; otherwise it prints nothing and returns 1.
#
# A refusal is never tried a second time (fleet_ssh_is_transient in
# lib-fleet-ssh.sh). No other script names the two ssh options or the file:
# scripts/test-fleet-hostkeys.sh fails any that does.
# ==============================================================================

fleet_known_hosts_file() {
    printf '%s' "${FLEET_KNOWN_HOSTS:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/known_hosts}"
}

fleet_hostkey_opts() {
    local f dir LC_ALL=C
    f="$(fleet_known_hosts_file)"
    # The scripts hand their ssh options over as one line of words, and ssh reads
    # a path as a pattern (% and ~ stand for other things). So the path is held to
    # plain characters instead of being quoted three ways.
    case "$f" in
        /*) ;;
        *) echo "ABORT: the known-hosts file must be a full path that starts with /. Got: $f" >&2
           echo "       Set FLEET_KNOWN_HOSTS to a full path, or unset it to use ~/.config/fleet/known_hosts." >&2
           return 1 ;;
    esac
    case "$f" in
        *[!A-Za-z0-9._/@+,:-]*)
           echo "ABORT: the known-hosts file's path has a character ssh options cannot carry (a space, for one): $f" >&2
           echo "       Set FLEET_KNOWN_HOSTS to a full path made of letters, digits and . _ - / only." >&2
           return 1 ;;
    esac
    dir="$(dirname "$f")"
    if [ ! -d "$dir" ]; then
        ( umask 077; mkdir -p "$dir" ) 2>/dev/null || { echo "ABORT: could not make the folder $dir for the known-hosts file. Make it yourself, or set FLEET_KNOWN_HOSTS to a file you can write." >&2; return 1; }
    fi
    if [ ! -e "$f" ]; then
        ( umask 077; : > "$f" ) 2>/dev/null || { echo "ABORT: could not make the known-hosts file $f. Check the folder's permissions, or set FLEET_KNOWN_HOSTS to a file you can write." >&2; return 1; }
    fi
    if [ ! -f "$f" ] || [ ! -r "$f" ] || [ ! -w "$f" ]; then
        echo "ABORT: the known-hosts file $f is not a file this account can read and write. Fix its permissions, or set FLEET_KNOWN_HOSTS to another file." >&2
        return 1
    fi
    printf '%s' "-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$f"
}

fleet_hostkey_is_refusal() {
    [ -s "$1" ] || return 1
    grep -qiE 'remote host identification has changed|host key verification failed' "$1"
}

fleet_hostkey_explain() {
    local ip="$1" f
    f="$(fleet_known_hosts_file)"
    echo "   STOP: ssh refused to connect to $ip. The host key it answered with is not the one saved for that address."
    echo "   Nothing was run on that server, and it was not tried again."
    echo "   This is expected after a server was rebuilt at the same address. If that is what happened,"
    echo "   forget the old key, then run this again:"
    echo "       ssh-keygen -R $ip -f $f"
    echo "   If the server was not rebuilt, stop and look into it before you connect: something else may be"
    echo "   answering at that address."
}

fleet_hostkey_refusal() {
    fleet_hostkey_is_refusal "$1" || return 1
    fleet_hostkey_explain "$2"
}
