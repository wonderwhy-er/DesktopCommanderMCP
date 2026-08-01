# Desktop Commander on Linux

Desktop Commander supports desktop Linux and headless Ubuntu/Debian servers.
The Linux runtime uses native shells, `ps`, filesystem permissions, signals,
and systemd rather than Windows-specific process APIs.

## Supported baseline

- Ubuntu 22.04 and 24.04
- Debian 12
- Node.js 20 and 22
- Bash, POSIX `sh`, Zsh, and Fish
- Desktop sessions using X11 or Wayland
- Headless VPS and server environments

## Local development

```bash
git clone https://github.com/wonderwhy-er/DesktopCommanderMCP.git
cd DesktopCommanderMCP
npm ci
npm run build
node test/test-linux-platform.js
```

Run the MCP server directly:

```bash
node dist/index.js
```

## Headless remote device

A Linux host without `DISPLAY`, `WAYLAND_DISPLAY`, or `MIR_SOCKET` is detected
as headless. Browser launch is skipped and the device authorization URL and code
remain visible in the terminal or systemd journal.

You can force the runtime mode:

```bash
export DESKTOP_COMMANDER_HEADLESS=true
```

Start a remote device manually:

```bash
desktop-commander remote --persist-session --disable-no-sleep
```

The persisted device session is stored under:

```text
~/.desktop-commander-device/device.json
```

The file is created with mode `0600`.

## systemd installation

Install the package globally first, then run:

```bash
sudo desktop-commander linux-service --user "$USER"
```

The installer refuses to create a root-owned remote agent by default. A root
service requires the explicit `--allow-root` flag and grants the connected AI
full root-level host access, so it is not recommended.

For a non-standard executable path:

```bash
sudo desktop-commander linux-service \
  --user "$USER" \
  --bin "$HOME/.npm-global/bin/desktop-commander"
```

From a source checkout, the equivalent installer is
`sudo ./scripts/install-linux-service.sh --user "$USER"`.

The installer enables the service but does not start it by default. Start it and
watch the first authorization flow with:

```bash
sudo systemctl start desktop-commander-device
sudo journalctl -u desktop-commander-device -f
```

Use `--start` to start it immediately during installation.

## Service management

```bash
systemctl status desktop-commander-device
sudo systemctl restart desktop-commander-device
sudo systemctl stop desktop-commander-device
journalctl -u desktop-commander-device --since today
```

The unit uses `KillMode=control-group`, so child shells and long-running commands
are stopped with the service. It also enables `NoNewPrivileges`, `PrivateTmp`,
and read-only protection for system directories.

## Security boundary

Run the service as a dedicated non-root user. Desktop Commander can execute
arbitrary commands with that user's permissions. Directory allowlists and the
command blocklist reduce mistakes but do not provide sandbox isolation. Use a
container or VM when the connected AI must not reach the wider host.
