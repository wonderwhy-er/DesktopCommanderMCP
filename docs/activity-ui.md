# MCP activity view — separate fork

This project adds an AI-authored activity stream without changing or restarting an existing Remote Desktop Commander device.

## One-call AI explanations

All standard operational tools from this fork now expose an **optional** `activity_description` argument. A model can provide a short explanation in the user's language **within the tool call itself**. This is preferred over a separate progress tool call; the terminal sees the status just before execution. Nothing in `activity_description` is executed, and no private tool inputs or full results are printed in the dashboard.

The MCP server also includes default activity guidance in its `initialize.instructions`. A client that obeys MCP tool descriptions can use this automatically: the user should not have to request it repeatedly. The optional `report_activity` tool remains available for significant completion notes, warnings and errors. When a model omits both, a generic **auto** tool-name status appears, never a fabricated model explanation.

MCP **cannot** impose a system prompt on ChatGPT or force a model to fill optional parameters. Client selection of MCP tool metadata and compliance with server hints depend on the host.

## Terminal activity monitor

**Run this only from the separately cloned fork**, not from the currently installed remote version:

```sh
cd /home/tayfur/DesktopCommanderMCP-fork-work
npm ci --ignore-scripts
npm run build
node dist/index.js activity
```

The monitor uses a private local Unix socket, by default `~/.cache/desktop-commander-activity/monitor.sock`; it neither opens an internet port nor reads/updates `~/.desktop-commander-device/device.json`. A normal local/stdio MCP process started under the same account publishes only descriptions, tool names, call IDs, statuses and elapsed times to the monitor. To inspect or configure a separate test instance without any local/global setup, launch `node /home/tayfur/DesktopCommanderMCP-fork-work/dist/index.js` as the MCP stdio command. The original `desktop-commander remote` must remain unchanged.

`DC_ACTIVITY_SOCKET` can override the socket path. The socket directory must already have owner-only permissions (0700) or be newly created with those permissions. `DC_ACTIVITY_UI=off` changes the monitor to compact text output even on an interactive terminal.

## Private ChatGPT integration: official Secure MCP Tunnel

The upstream **hosted** Remote Desktop Commander plugin at `mcp.desktopcommander.app` decides which tools are presented to ChatGPT. We do not control its server and cannot force it to advertise the new activity fields. Merely installing this fork will not replace its published tool list.

For a **separate connection**, the official Secure MCP Tunnel can forward to a private local **stdio MCP server** without inbound ports. This requires a Platform tunnel ID, a runtime API key, the relevant tunnel permissions, and a one-time ChatGPT custom MCP plugin connection. Do not copy secrets into source files or publish them on GitHub.

Official docs: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

After receiving the tunnel ID and **securely** entering the runtime key locally, you can initialize the tunnel (adjust the checkout path):

```sh
# Example only: requires an authorized OpenAI Platform tunnel and locally supplied runtime key.
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile local-stdio \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command "node /home/tayfur/DesktopCommanderMCP-fork-work/dist/index.js"

tunnel-client doctor --profile local-stdio --explain
tunnel-client run --profile local-stdio
```

The tunnel client and `node dist/index.js activity` monitor run in **separate** terminals. The fork's stdio server is spawned by the tunnel client and publishes events to the monitor. Use ChatGPT Plugins → Add custom MCP server → Tunnel to create your own additional plugin. Keep existing Remote Desktop Commander connected until this independent plugin has been verified. The tunnel is optional and **has not been created, started, or authorized by this development work**.

The tunnel grants significant control over a computer. Use the narrowest feasible tool permissions and ordinary ChatGPT approval controls. A model-authored display message **never** substitutes for user approval.

## Isolated validation

```sh
cd /home/tayfur/DesktopCommanderMCP-fork-work
npm run build
node --test test/activity-ui.test.js test/activity-mcp.smoke.test.js test/activity-local-monitor.integration.test.js
```

Tests create temporary home directories and local sockets. They do not register another Remote Device or access the installed device credentials.
