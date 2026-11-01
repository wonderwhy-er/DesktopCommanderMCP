# Desktop Commander Remote MCP

Desktop Commander Remote MCP lets web-based AI clients such as **ChatGPT** and **Claude** use Desktop Commander tools on your computer. The Remote Device is a local process that connects your machine to the Desktop Commander Remote MCP service; commands still execute locally under your user account.

## Quick start

### Prerequisites

- Node.js 18 or newer
- A Desktop Commander account
- An AI client that can connect to the Desktop Commander Remote MCP

### 1. Start the Remote Device

The recommended command is:

```bash
npx @wonderwhy-er/desktop-commander@latest remote
```

If Desktop Commander is installed globally, the shorter equivalent is:

```bash
desktop-commander remote
```

### 2. Authenticate

On first run, Desktop Commander starts an OAuth device-authorization flow:

1. A browser window opens to the verification page.
2. Confirm that the verification code matches the code printed in your terminal.
3. Sign in and authorize the device.
4. The local Remote Device connects automatically.

If the browser does not open, use the verification URL and code printed in the terminal.

By default, the authenticated device session is saved to:

```text
~/.desktop-commander-device/device.json
```

On POSIX systems, the file is created with mode `0600` (read/write for the owning user only). On Windows, this code does not set a custom owner-only ACL; access is governed by the Windows filesystem permissions for the user profile. Restarting the Remote Device normally reuses this saved session, so browser authorization is not required on every start.

### 3. Connect your AI

Open **[mcp.desktopcommander.app](https://mcp.desktopcommander.app)** and follow the connection instructions for your AI client. Once both the AI connection and the local Remote Device are active, the AI can use Desktop Commander tools on your computer.

### 4. Keep the Remote Device running

The local process must be running for remote tool calls to reach your computer.

- Press `Ctrl+C` to stop it temporarily.
- Start the same `remote` command again to reconnect.
- Stopping the process does not remove saved credentials or revoke the device.

## How it works

The request path is:

```text
AI client → Desktop Commander Remote MCP → Remote Device → local Desktop Commander MCP server
```

The Remote MCP service forwards tool calls to the connected device. The local Desktop Commander MCP server executes them and returns the result through the same connection.

## Session persistence

Session persistence is enabled by default. To require browser authorization on every start, run:

```bash
npx @wonderwhy-er/desktop-commander@latest remote --no-persist-session
```

## Stop, logout, revoke, or disconnect

These actions affect different parts of the Remote MCP connection:

| Action | What it does | Saved local credentials | Server-side device authorization |
| --- | --- | --- | --- |
| Press `Ctrl+C` | Takes this computer offline until you start the Remote Device again | Kept | Kept |
| `remote --logout` | Removes saved Remote MCP credentials from this computer | Removed | Kept |
| **Revoke** the device in the Remote MCP dashboard | Invalidates that device authorization on the server | May still exist locally | Revoked |
| Disconnect/remove the Remote MCP connector in your AI client | Removes that AI client's connection to Remote MCP | Kept | Device authorization is unchanged |

### Log out locally

Run:

```bash
npx @wonderwhy-er/desktop-commander@latest remote --logout
```

This removes `~/.desktop-commander-device/device.json`. It does **not** revoke the device in the Remote MCP dashboard.

For a completely clean authorization reset, revoke the device in the dashboard, log out locally, then start `remote` and pair again.

## CLI reference

Show the built-in help:

```bash
npx @wonderwhy-er/desktop-commander@latest remote --help
```

The `-h` alias is also supported.

| Option | Purpose |
| --- | --- |
| `--logout` | Remove saved local Remote MCP credentials and exit |
| `--no-persist-session` | Do not reuse or save authentication for this run |
| `--disable-no-sleep` | Do not prevent sleep while the Remote Device is running |
| `--debug` | Enable verbose debug logging |
| `-h`, `--help` | Show CLI help |

Common examples:

```bash
# Start normally
npx @wonderwhy-er/desktop-commander@latest remote

# Start with verbose diagnostics
npx @wonderwhy-er/desktop-commander@latest remote --debug
```

```bash
# Start without saving/reusing the session
npx @wonderwhy-er/desktop-commander@latest remote --no-persist-session

# Remove saved local credentials
npx @wonderwhy-er/desktop-commander@latest remote --logout
```

### Sleep behavior on macOS

By default, the Remote Device uses macOS `caffeinate` while it is running so the machine does not go to sleep and unexpectedly become unavailable. To disable that behavior:

```bash
npx @wonderwhy-er/desktop-commander@latest remote --disable-no-sleep
```

## Troubleshooting

### The browser did not open during authentication

Use the verification URL and code printed in the terminal. The OAuth device flow does not require a local callback server.

### The device shows offline

Make sure the terminal running the Remote Device is still open. Restart:

```bash
npx @wonderwhy-er/desktop-commander@latest remote
```

A normal restart reuses saved credentials. If the device authorization was revoked or is no longer valid, the CLI will require authorization again.

### I want to switch accounts or start with fresh authentication

For a local re-authentication, remove the saved credentials:

```bash
npx @wonderwhy-er/desktop-commander@latest remote --logout
```

For a complete reset, also revoke the old device from the Remote MCP dashboard before pairing again.

### I need more diagnostic output

Start with verbose logging:

```bash
npx @wonderwhy-er/desktop-commander@latest remote --debug
```

### My AI client cannot reach the device

Check both sides of the connection:

1. The local Remote Device process is running.
2. The device appears connected in the Remote MCP dashboard.
3. The Remote MCP connector is still connected in your AI client.
4. If needed, restart with `--debug` and inspect the local output.

Do not revoke and reauthorize the device as a generic first troubleshooting step when the device is online and ordinary calls work.

## Development

For contributors working from the repository:

```bash
git clone https://github.com/wonderwhy-er/DesktopCommanderMCP.git
cd DesktopCommanderMCP
npm install
npm run build
node dist/index.js remote --debug
```

You can also run the Remote Device source directly:

```bash
npm run device:start
```

Or run it with automatic restart during development:

```bash
npm run device:start:dev
```

These contributor commands are separate from the recommended end-user command, `npx @wonderwhy-er/desktop-commander@latest remote`.

## Security and history

- **Local execution:** tool calls execute on your computer under your user permissions.
- **Explicit availability:** remote calls can reach the computer only while the Remote Device is running and connected.
- **Authentication:** the device uses OAuth authentication to connect to the Remote MCP service.
- **Local history:** the local Desktop Commander MCP server records tool-call history on the device. See [Local tool history and audit logs](../../README.md#local-tool-history-and-audit-logs) for storage locations and retention behavior.
- **Remote retention:** the Remote MCP service temporarily stores tool arguments and results in `mcp_remote_calls` so calls can be routed and completed. Terminal rows are automatically swept shortly after completion (eligible for deletion after one minute, with a one-hour creation-time backstop), so they are not kept as a long-term historical audit log.

For general support, see the [Desktop Commander README](../../README.md) and [GitHub issues](https://github.com/wonderwhy-er/DesktopCommanderMCP/issues).
