# Desktop Commander - Native Activity Monitor

An optional terminal dashboard for **real MCP tool executions**. No generated narration, no chat transcript, no displayed command arguments, and no source-code preview. The dashboard reports tool names, active/finished/error state, elapsed time and accumulated counts.

## Run (independent checkout)

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/index.js activity
```

Connect a separate MCP client to `node /absolute/path/to/dist/index.js --no-onboarding`. The client and monitor need to run under the same OS account. The monitor itself is read-only, uses a local IPC endpoint, does not start a Remote Device, and does not require an external tunnel.

## Terminal controls

| Input | Action |
|---|---|
| Mouse wheel / Up / Down | Scroll activity history |
| PageUp / PageDown | Scroll a page |
| Home / End | Oldest / newest |
| Q or Ctrl+C | Quit and restore terminal |

In an interactive terminal, raw keyboard input prevents literal `^[[A` or `^[[B` escape sequences being echoed. The UI uses the alternate screen and enables mouse-wheel reporting only while active, then restores terminal state on exit. A non-interactive terminal prints compact factual event lines. \`NO_COLOR=1\` retains the interactive UI with monochrome output; \`DC_ACTIVITY_UI=off\` switches to line-oriented output.

## Privacy and safety

The MCP server generates start and finish events for real tool invocations. Free-form AI explanations are not requested, transmitted, or displayed. The monitor never displays tool arguments or tool output. Event names are validated; operations and permissions stay with the MCP server and its client.

On Unix the monitor uses a protected Unix socket. Its parent directory must belong to the user and have no group/other permissions; an existing live socket will not be overwritten. On Windows it uses a named pipe (additional pipe ACL/security testing needed for production deployment). History is bounded to 1000 rows and active call tracking is bounded. An exceptional tracking overflow is flagged on-screen.

The monitor is **not** a secure command-approval mechanism. Host approvals and file-system access restrictions must be enforced elsewhere.

## Tests

```sh
node --test test/activity-ui.test.js test/activity-mcp.smoke.test.js \
  test/activity-local-monitor.integration.test.js \
  test/activity-monitor-hardening.test.js test/activity-terminal-pty.test.js
```

The POSIX pseudo-terminal test explicitly verifies arrow/mouse handling and raw-mode restoration. Before claiming cross-platform production readiness, see [production readiness checklist](activity-production-readiness.md), run the full project regression suite and cross-platform CI, and perform manual operator acceptance tests.
