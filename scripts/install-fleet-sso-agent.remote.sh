# ==============================================================================
# Fleet sign-in service installer: the part that runs ON a server, as root.
# ==============================================================================
# Sent over ssh by install-fleet-sso-agent.sh, which puts these assignments in
# front of it. They travel inside the program text, never as arguments, so the
# token is on no command line on either machine:
#
#   MODE=audit|apply|remove   SERVER_ID   TOKEN   SUPABASE_URL   ANON_KEY
#   AGENT_B64   SIGN_PUB_B64   BOX_PUB_B64        (the last five only for apply)
#
# audit   read-only: what is installed, and whether this server can run it
# apply   writes four files, proves them with the service's own --check, and
#         only then starts the service:
#           /usr/local/sbin/fleet-sso-agent                 the service
#           /etc/fleet-sso/agent.conf                       its settings (root only)
#           /etc/fleet-sso/sign-pub.pem, box-pub.pem        Fleet's public keys
#           /etc/systemd/system/fleet-sso-agent.service     what keeps it running
#         If --check fails the service is left stopped.
# remove  stops the service and deletes those files. Nothing else was ever
#         changed, so nothing else needs undoing.
#
# It opens no port and changes no firewall rule: the service only calls out.
# It prints no token. The last line is sso_install_result=ok|stop.
#
# SSO_INSTALL_ROOT is for the local test only: it prefixes every path.
#
# __FLEET_REPO_URL__ (the unit's Documentation= line) is filled in by the sender
# from fleet.config.ts before this program is sent (scripts/lib-fleet-names.sh).
# ==============================================================================
set -u
export LC_ALL=C
R="${SSO_INSTALL_ROOT:-}"
D="$R/etc/fleet-sso"
BIN="$R/usr/local/sbin/fleet-sso-agent"
UNIT="$R/etc/systemd/system/fleet-sso-agent.service"
SVC=fleet-sso-agent
stop() { echo "STOP: $*"; echo "sso_install_result=stop"; exit 1; }
case '__FLEET_REPO_URL__' in (https://*) ;; (*) stop "this program arrived without its values filled in; nothing changed" ;; esac   # names-guard

case "${MODE:-}" in audit|apply|remove) ;; *) stop "no mode given; nothing changed" ;; esac

gp_path() { for p in /usr/local/bin/gp /usr/bin/gp /usr/local/sbin/gp /usr/sbin/gp; do [ -x "$R$p" ] && { echo "$p"; return 0; }; done; return 1; }
token_fp() { [ -r "$D/agent.conf" ] && sed -n 's/^AGENT_TOKEN=//p' "$D/agent.conf" | head -1 | tr -d '\n' | sha256sum | cut -c1-8; }

facts() {
    echo "python=$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo MISSING)"
    echo "openssl=$([ -x "$R/usr/bin/openssl" ] && { "$R/usr/bin/openssl" version 2>/dev/null | cut -d' ' -f1-2; } || echo MISSING)"
    echo "gp=$(gp_path || echo MISSING)"
}

state() {
    if [ -f "$BIN" ]; then echo "installed=yes"; else echo "installed=no"; fi
    echo "service=$(systemctl is-active "$SVC" 2>/dev/null || true)"
    echo "starts_at_boot=$(systemctl is-enabled "$SVC" 2>/dev/null || true)"
    if [ -r "$D/agent.conf" ]; then echo "token_fp=$(token_fp)"; fi
}

if [ "$MODE" = "audit" ]; then
    facts; state
    if [ -f "$BIN" ]; then
        echo "--- last lines of its log ---"
        journalctl -u "$SVC" -n 4 --no-pager -o cat 2>/dev/null | cut -c1-160
    fi
    echo "sso_install_result=ok"
    exit 0
fi

if [ "$MODE" = "remove" ]; then
    systemctl disable --now "$SVC" >/dev/null 2>&1
    rm -f "$UNIT" "$BIN" "$D/agent.conf" "$D/sign-pub.pem" "$D/box-pub.pem"
    rmdir "$D" 2>/dev/null
    systemctl daemon-reload >/dev/null 2>&1
    state
    if [ -e "$BIN" ] || [ -e "$UNIT" ] || [ -e "$D" ]; then stop "something is still there; look at $D"; fi
    echo "removed=yes"
    echo "sso_install_result=ok"
    exit 0
fi

# ---- apply --------------------------------------------------------------------
facts
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null || stop "this server needs python3 3.6 or newer; nothing changed"
[ -x "$R/usr/bin/openssl" ] || stop "no /usr/bin/openssl; nothing changed"
gp_path >/dev/null || stop "gp was not found; is this a GridPane server? nothing changed"
printf '%s' "${SERVER_ID:-}" | grep -qE '^[1-9][0-9]{0,11}$' || stop "no server id; nothing changed"
printf '%s' "${TOKEN:-}" | grep -qE '^[0-9a-f]{64}$' || stop "no token; nothing changed"
for v in AGENT_B64 SIGN_PUB_B64 BOX_PUB_B64 SUPABASE_URL ANON_KEY; do [ -n "${!v:-}" ] || stop "$v is missing; nothing changed"; done

umask 077
mkdir -p "$D" "$(dirname "$BIN")" "$(dirname "$UNIT")" || stop "could not make $D"
chmod 700 "$D"
NEW="$(mktemp -d "$D/.new.XXXXXX")" || stop "could not make a work folder in $D"
trap 'rm -rf "$NEW"' EXIT
printf '%s' "$AGENT_B64"    | base64 -d > "$NEW/agent"        || stop "the service file did not arrive whole; nothing changed"
printf '%s' "$SIGN_PUB_B64" | base64 -d > "$NEW/sign-pub.pem" || stop "a key did not arrive whole; nothing changed"
printf '%s' "$BOX_PUB_B64"  | base64 -d > "$NEW/box-pub.pem"  || stop "a key did not arrive whole; nothing changed"
grep -q 'BEGIN PUBLIC KEY' "$NEW/sign-pub.pem" && grep -q 'BEGIN PUBLIC KEY' "$NEW/box-pub.pem" || stop "those are not public keys; nothing changed"
# Does THIS server's Python accept the service? Better to learn that now than from a crash loop.
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$NEW/agent" 2>/dev/null || stop "this server's python3 cannot read the service file; nothing changed"
{
    echo "# Written by install-fleet-sso-agent.sh. Holds this server's sign-in token: root only."
    echo "SUPABASE_URL=$SUPABASE_URL"
    echo "SUPABASE_ANON_KEY=$ANON_KEY"
    echo "SERVER_ID=$SERVER_ID"
    echo "AGENT_TOKEN=$TOKEN"
} > "$NEW/agent.conf"

# Everything arrived and reads correctly: put the four files in place.
chmod 600 "$NEW/agent.conf" "$NEW/sign-pub.pem" "$NEW/box-pub.pem"; chmod 755 "$NEW/agent"
mv -f "$NEW/sign-pub.pem" "$D/sign-pub.pem" && mv -f "$NEW/box-pub.pem" "$D/box-pub.pem" && mv -f "$NEW/agent.conf" "$D/agent.conf" && mv -f "$NEW/agent" "$BIN" || stop "could not put the files in place"
( umask 022; cat > "$UNIT" <<'UNITFILE'
[Unit]
Description=Fleet one-click sign-in service
Documentation=__FLEET_REPO_URL__
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 /usr/local/sbin/fleet-sso-agent
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNITFILE
)
echo "token_fp=$(token_fp)"

echo "--- the service checks itself (it mints nothing) ---"
if python3 "$BIN" --check 2>&1 | cut -c1-200; [ "${PIPESTATUS[0]}" -eq 0 ]; then
    systemctl daemon-reload
    systemctl enable "$SVC" >/dev/null 2>&1
    systemctl restart "$SVC"
    sleep 3
    state
    [ "$(systemctl is-active "$SVC" 2>/dev/null)" = "active" ] || stop "the files are in place and the check passed, but the service did not stay running: journalctl -u $SVC -n 30"
    echo "sso_install_result=ok"
else
    systemctl disable --now "$SVC" >/dev/null 2>&1
    systemctl daemon-reload >/dev/null 2>&1
    state
    stop "the check failed, so the service was left stopped. One-click sign-in will not work for sites on this server until it passes"
fi
