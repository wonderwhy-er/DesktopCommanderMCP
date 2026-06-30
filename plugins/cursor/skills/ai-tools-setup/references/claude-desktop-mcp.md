# Claude Desktop & MCP Servers

How to install Claude Desktop, add MCP servers, and inspect / validate / repair
MCP configuration files. This is the most common and most mechanical task — high
success rate when done carefully.

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

## Connection health check

Separate the three failure classes so you fix the right thing:

- **Config typo** → client shows the server as failed immediately on start; the
  JSON or command is wrong. Fix the file.
- **Server down / crashes** → server starts then exits; running the command
  manually reproduces the crash. Fix deps/runtime.
- **Auth failure** → server starts and lists tools, but calls fail with 401/403.
  Fix the API key/token.

## Claude Desktop install

If Claude Desktop itself isn't installed, point the user to the official
download and confirm the app launches before touching MCP config. Don't
side-load from unofficial mirrors.

## Safety

- Only add MCP servers from sources the user trusts; an MCP server runs with the
  user's privileges.
- Back up before editing; redact secrets in summaries; restart the client to
  apply changes.
