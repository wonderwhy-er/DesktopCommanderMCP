# Claude Desktop & MCP Servers

How to install Claude Desktop, add MCP servers, and inspect / validate / repair
MCP configuration files. This is the most common and most mechanical task — high
success rate when done carefully.

## Where a server actually comes from

Work out which mechanism launches the server before editing anything. They fail
independently and can serve the *same* tools:

- **A config-file entry** someone wrote by hand or with a setup script — the
  table below.
- **An extension** (`.mcpb` / `.dxt`) the client installed and launches with its
  own bundled Node. Nothing about it appears in `claude_desktop_config.json`.
- **A plugin**, which declares its own `mcpServers` block inside `plugin.json`.
  Also absent from `claude_desktop_config.json`.

This matters when the settings page reports a failure. "Unable to connect to
extension server" next to something called `desktop-commander` may be the
*plugin's* server while the identically-named extension is running fine and
serving tools. Confirm in the logs which of the two is actually broken before
touching a config file — the logs name them differently (`[Display Name]` for an
extension, `plugin:<plugin>:<server>` for a plugin).

## Config file locations

MCP-capable clients each keep their own config. Find the right one first.

| Client | macOS | Windows |
|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code (per project) | `<project>/.claude/mcp.json` or `.mcp.json` | same |
| LM Studio | `~/.lmstudio/mcp.json` | `%USERPROFILE%\.lmstudio\mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |

If the file doesn't exist yet, create it with a minimal valid skeleton:

```json
{ "mcpServers": {} }
```

## Anatomy of an MCP server entry

A stdio server entry has a launch `command`, `args`, and optional `env`:

```json
{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "@scope/some-mcp-server"],
      "env": { "SOME_API_KEY": "..." }
    }
  }
}
```

Notes:
- On Windows, `npx` sometimes must be invoked as `cmd /c npx ...` — if a server
  fails to launch on Windows but works on macOS, try wrapping the command.
- Use absolute paths for local scripts; `~` is not expanded inside JSON.
- Secrets belong in `env` here (or the server's own config), never pasted into
  chat.
- `@latest` in an `npx` arg re-resolves the version on **every** launch. When the
  cached copy is stale, npx reinstalls the whole dependency tree before the
  server can answer `initialize` — see "Slow cold start on Windows" below. For a
  server the client auto-starts, a pinned version is far more predictable.

## Add a server end-to-end

1. **Confirm prerequisites.** Most MCP servers need Node (check `node -v`; many
   need 18+). Some need Python or Docker. Install the runtime if missing.
2. **Back up the config** (`claude_desktop_config.json` →
   `claude_desktop_config.json.bak`).
3. **Add the server block** under `mcpServers`. Preserve existing entries.
4. **Validate the JSON** (parse it; check for trailing commas, unescaped
   backslashes in Windows paths, missing quotes).
5. **Fully restart the client.** Claude Desktop must be quit and reopened — a
   window reload is not enough.
6. **Verify.** Confirm the server appears and its tools are listed. If the
   client shows a "failed" server, read its MCP log.

## Inspect, validate, repair (the core job)

When a user says MCP "isn't working," diagnose in this order:

1. **Read the config file** and pretty-print it. Most breakages are here.
2. **Validate JSON.** The frequent culprits:
   - trailing comma after the last entry
   - single backslashes in Windows paths (need `\\` or forward slashes)
   - smart quotes from copy-paste instead of straight quotes
   - a server block pasted at the wrong nesting level
3. **Check the launch command resolves** — does `command` exist on PATH? Run it
   manually in a terminal to see the real error.
4. **Check credentials** — is the required `env` key present and valid?
5. **Repair, back up first, restart the client, then re-verify.**

## Where the logs are

Read the logs instead of guessing — they name the exact launch command, the
`PATH` it ran with, and the real error. Recent Claude Desktop builds moved the
Windows log directory and the old one simply stops being written to, so a
stale-looking directory is *not* evidence that nothing ran.

| Claude Desktop | Windows |
|---|---|
| current (verified on 1.34493.1) | `%LOCALAPPDATA%\Claude\Logs\` |
| older builds | `%APPDATA%\Claude\logs\` |

On macOS the logs live under `~/Library/Logs/Claude/`.

Files worth opening:

- `main.log` — the client's own view: which server it is starting, with what
  command, and why a connection failed. Grep for `LocalMcpServerManager`
  (plugin-provided servers) and `localMcpBridge`.
- `mcp.log` and `mcp-server-<Display Name>.log` — per-server JSON-RPC traffic. A
  server that answers `initialize` and lists tools here is up, and the problem is
  somewhere else.

## Slow cold start on Windows (`npx`-launched servers)

Symptom: the extensions/plugins page shows *"Unable to connect to extension
server. Please try disabling and re-enabling the extension."* Toggling it changes
nothing, and `main.log` shows the same attempt failing on a loop:

```
[LocalMcpServerManager] Connecting to plugin:<plugin>:<server>
[LocalMcpServerManager] Failed to connect to plugin:<plugin>:<server>:
    Request timed out { code: 'REQUEST_TIMEOUT', data: { timeout: 120000 } }
```

Cause, when the launch command is `npx -y <pkg>@latest`: npm re-resolves
`@latest` on every start, and if the npx-cached copy is behind the published
version it reinstalls the entire dependency tree *before* the server can answer
`initialize`. A ~500-package tree on AV-scanned corporate hardware has been
measured at ~75 s, which is past the client's connect timeout. The client then
kills the process mid-install, leaving a half-written tree in the npx cache —
running the cached entry point directly then fails with
`Error: Cannot find module '<dep>'`. The next launch reinstalls again. It never
converges on its own, which is exactly why disable/enable does not help.

The npx cache key is a hash of the *spec string*, not of the resolved version, so
`<pkg>@latest` keeps reinstalling in place over the same directory rather than
building a fresh one alongside it.

Fix — complete the install once outside the client, where nothing kills it:

```powershell
# 1. drop the half-written cache entry
Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Directory |
  Where-Object { Test-Path "$($_.FullName)\node_modules\<scope>\<pkg>" } |
  Remove-Item -Recurse -Force

# 2. install it fully, without starting the server
npm exec --yes --package=<pkg>@latest -- node -e "console.log('ok')"
```

Then let the client retry on its own, or toggle the extension. Confirm in
`main.log`:

```
[LocalMcpServerManager] Connected to plugin:<plugin>:<server> (N tools)
```

Measure rather than assume: spawn the launch command yourself, write a single
`initialize` request to its stdin, and time the reply. Healthy is seconds. If
nothing comes back within a couple of minutes, you are watching an install, not a
hung server.

This recurs on every new release of the package. Pinning an exact version in the
launch args avoids it for good — a pinned spec gets its own cache key and is
never reinstalled.

## Connection health check

Separate the failure classes so you fix the right thing:

- **Config typo** → client shows the server as failed immediately on start; the
  JSON or command is wrong. Fix the file.
- **Server down / crashes** → server starts then exits; running the command
  manually reproduces the crash. Fix deps/runtime.
- **Auth failure** → server starts and lists tools, but calls fail with 401/403.
  Fix the API key/token.
- **Cold start too slow** → the client times out and retries indefinitely while
  the process is still installing or starting. Nothing in the config is wrong and
  running the command by hand eventually works. See "Slow cold start on Windows".

## Claude Desktop install

If Claude Desktop itself isn't installed, point the user to the official
download and confirm the app launches before touching MCP config. Don't
side-load from unofficial mirrors.

## Safety

- Only add MCP servers from sources the user trusts; an MCP server runs with the
  user's privileges.
- Back up before editing; redact secrets in summaries; restart the client to
  apply changes.
