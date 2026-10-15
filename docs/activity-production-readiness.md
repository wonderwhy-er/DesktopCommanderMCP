# Activity monitoring: production readiness and maintainer review

## Proposed upstream scope

Add optional, **model-authored** `activity_description` on operational MCP tools, a separate optional `report_activity` tool, and a local activity monitor. Descriptions are presentation-only; they must never be interpreted as permissions, executable instructions, or claims of successful execution. When a client omits them, use an explicitly labeled automatic tool-name fallback.

This work should be reviewed as an optional upstream feature, **not** as a replacement of the existing remote service. No changes to the original installation, its credentials, or the hosted provider are required to review it.

## Verified in isolated development

- TypeScript build and real stdio MCP integration
- Live AI-authored inline descriptions and IPC event delivery
- Long-running total counts, bounded completed-row history, duplicate finalization
- Terminal control-code stripping and masking common secrets
- Owner-only Unix-socket directories; refusal to overwrite another live monitor or a regular file; recovery of stale local sockets
- Separate terminal screen and resize handling (code-level; manual interactive review still recommended)
- Existing Remote Device regression checks (except an unrelated float-comparison assertion in the reconnect test; see below)

## Release blockers and further review

- **Full upstream suite:** Not yet validated. Existing test/remote-channel-reconnect floating-point monotonicity assertion fails when `120000.00000000003` precedes `120000`. This appears unrelated to the activity changes but must be triaged or fixed independently.
- **Cross-platform:** Linux validated. macOS terminal/Unix sockets and Windows named-pipe security/permissions need dedicated CI and manual checks.
- **Client behavior:** MCP `initialize.instructions` are non-binding. ChatGPT/Claude may omit the optional field, so do not promise AI-written text on every call.
- **Privacy:** Redaction covers common credential patterns but is not a formal guarantee. Never include full command arguments, tool results, tokens, source content, or private reasoning in activity events. Review threat models and optional strict no-model-text mode before publishing widely.
- **Operational reliability:** The private OpenAI tunnel is a deployment concern and is **not part of the feature**. A tmux-managed tunnel did not come back after a Kali host reboot. A user-approved service manager and restart policy are required for unattended service. Do not enable auto-start without the device owner's approval.
- **TUI accessibility:** Check narrow terminals, screen readers, escape sequences, long UTF-8 text, and non-interactive output manually before production release.
- **Compatibility:** Validate existing MCP client discovery and tool schema differences across product versions. The local feature may never be exposed through the original proprietary hosted connector.

## Isolated commands

~~~sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node --test test/activity-ui.test.js test/activity-mcp.smoke.test.js test/activity-local-monitor.integration.test.js test/activity-monitor-hardening.test.js
~~~

Run `node dist/index.js activity` only for the monitor. Local development uses `node dist/index.js --no-onboarding` as a separate stdio MCP server. This feature does not require anyone to replace a running remote daemon.

## Optional deployment example (not enabled by this PR)

A standalone user-level service can supervise a **separate** tunnel-client process. Use only if you own the host, accept ongoing remote-device exposure, and understand how to disable the service.

Example user unit at `~/.config/systemd/user/mcp-activity-tunnel.service`:

~~~ini
[Unit]
Description=Private MCP activity tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/tunnel-client run --profile activity-fork --profile-dir %h/.config/tunnel-client-fork-activity
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
~~~

This is documentation **only**. Before enabling it, stop any existing separately managed `activity-fork` instance and review its secret-file permissions, account access, and approval settings. Do not run two tunnel daemons for the same tunnel ID. Only enable it through an explicit owner-controlled deployment action; do not add a tunnel runtime to the general upstream distribution.

## Maintainer acceptance criteria

1. Feature is opt-in or has a safe backward-compatible no-TUI fallback.
2. No changes to actual shell/file tool semantics and no extra authorization bypass.
3. Tests and CI run without OpenAI API keys or live tunnels.
4. Production logs never include unfiltered tool arguments or MCP results.
5. The UI clearly distinguishes model-written text from generic automatic fallbacks.
6. Client limitations, supported operating systems, and security boundaries are documented.
7. At least one release-candidate test cycle and upstream review are completed before publishing a production release.
