#!/usr/bin/env bash
#
# The numbers in #743's description, reproducible.
#
# test-remote-device-restart-unattended.js restarts a device by spawning it
# again. This does it the way the report does: a systemd unit with
# Restart=always, left running, so the restarting is systemd's and the state
# between restarts is only what is on disk.
#
# Two units run side by side for the same window:
#
#   dc695-fixed    this branch as it stands
#   dc695-broken   the same, with the rotation->disk wiring dropped (0.2.50)
#
# and it prints, per unit: restarts, how many came up, how many demanded a
# browser, the refresh token left on disk, and the journal lines the reporters
# pasted.
#
# Needs a user systemd instance - not root. Verified on WSL2 Ubuntu 24.04 with
# Node 24.10 against a Windows checkout over /mnt/c, where `sudo` was not
# available; a system unit would want root and buys nothing here.
#
#   npm run build
#   bash test/helpers/systemd-restart-probe.sh [seconds]     # default 170
#
# Leaves ~/.config/systemd/user/dc695-*.service and ~/dc695-* behind unless
# KEEP=0, which is the default; pass KEEP=1 to inspect them.
set -euo pipefail

WINDOW="${1:-170}"
KEEP="${KEEP:-0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

SCENARIO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/unattended-restart-scenario.js"
NODE="$(command -v node)"

# Not is-system-running: it exits non-zero for a degraded instance, which is
# still perfectly able to run these units. Asking for a property proves the bus.
if ! systemctl --user show -p Version --value >/dev/null 2>&1; then
    echo "no user systemd instance reachable (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR)" >&2
    exit 1
fi
[ -f "$SCENARIO" ] || { echo "missing $SCENARIO" >&2; exit 1; }
[ -n "$NODE" ] || { echo "node not on PATH" >&2; exit 1; }

mkdir -p ~/.config/systemd/user

unit() { # $1 name  $2 DC_PERSIST_ROTATION
    local w="$HOME/dc695-$1"
    rm -rf "$w"; mkdir -p "$w"
    printf '{"current":{"access":"access-1","refresh":"refresh-1"},"spent":[]}\n' > "$w/ledger.json"
    printf '{"deviceId":"device-1","session":{"access_token":"access-1","refresh_token":"refresh-1"}}\n' > "$w/device.json"
    cat > ~/.config/systemd/user/"dc695-$1".service <<UNIT
[Unit]
Description=DC-695 unattended restart probe ($1)
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$NODE $SCENARIO
Restart=always
RestartSec=1
Environment=DC_CONFIG=$w/device.json
Environment=DC_LEDGER=$w/ledger.json
Environment=DC_ROTATE=1
Environment=DC_PERSIST_ROTATION=$2
Environment=DESKTOP_COMMANDER_DISABLE_TELEMETRY=1
StandardOutput=append:$w/out.log
StandardError=append:$w/out.log
UNIT
}

unit fixed 1
unit broken 0
systemctl --user daemon-reload
systemctl --user start dc695-fixed.service --no-block
systemctl --user start dc695-broken.service --no-block

echo "running both units for ${WINDOW}s..."
sleep "$WINDOW"

for name in fixed broken; do
    w="$HOME/dc695-$name"
    echo "--- $name"
    echo "    is-active:          $(systemctl --user is-active "dc695-$name.service" || true)"
    echo "    NRestarts:          $(systemctl --user show "dc695-$name.service" -p NRestarts --value)"
    echo "    came up:            $(grep -c 'RESULT: READY' "$w/out.log" || true)"
    echo "    demanded a browser: $(grep -c 'RESULT: BROWSER_REQUIRED' "$w/out.log" || true)"
    echo "    failed a write:     $(grep -c 'RESULT: WRITE_FAILED' "$w/out.log" || true)"
    echo "    token on disk:      $(grep -o '"refresh_token": "[^"]*"' "$w/device.json" | head -1)"
    echo "    already used:       $(grep -c 'Invalid Refresh Token: Already Used' "$w/out.log" || true)"
    echo "    session invalid:    $(grep -c 'Persisted session invalid' "$w/out.log" || true)"
    systemctl --user stop "dc695-$name.service" || true
done

if [ "$KEEP" = "0" ]; then
    rm -f ~/.config/systemd/user/dc695-fixed.service ~/.config/systemd/user/dc695-broken.service
    rm -rf "$HOME/dc695-fixed" "$HOME/dc695-broken"
    systemctl --user daemon-reload
fi
