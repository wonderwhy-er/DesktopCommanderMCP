# Optional MCP activity monitor

Desktop Commander can show a concise terminal view of MCP operations without dumping raw tool arguments, metadata, or full command results into the activity screen.

## How it works

- Each operational MCP tool accepts an optional `activity_description` string. The client can supply a short, factual, user-language explanation **in the same tool call**, before execution.
- The separate `report_activity` tool provides free-standing plan, progress, completion, warning, and failure notes.
- A missing model-authored explanation falls back to a short tool-name label tagged `auto`. Explanations actually provided by a model are tagged `AI`. Neither label is an authorization decision.
- Structured start/end events are sent over a local, owner-only Unix socket (or local Windows named pipe). A separate monitor displays the current operation state, duration, and cumulative counts.
- The monitor keeps a bounded event history, limits the number of tracked active calls, handles duplicate finish events, and attempts safe recovery of stale sockets left by crashes.

The original tool outcome, side effects, permissions, and approval decisions are unchanged. An explanation never authorizes command execution or claims success in advance.

## Local development

From an independent checkout:

~~~sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/index.js activity
~~~

Configure a **separate local MCP stdio client** to start `node /absolute/path/to/checkout/dist/index.js --no-onboarding`. The client and monitor must run as the same authorized OS user (and use the same `DC_ACTIVITY_SOCKET` value if overriding the default).

Do not run a second Remote Device using the same saved identity while an existing Remote Device is running. The activity monitor alone does not create or register another remote device.

## Controls

- `DC_ACTIVITY_SOCKET`: set a custom local event socket path. On Unix, its parent directory must be owner-only (0700).
- `DC_ACTIVITY_UI=off`: use compact text output rather than the alternate-screen terminal display.
- `NO_COLOR=1`: disable interactive terminal rendering.

For a local development smoke test:

~~~sh
node --test test/activity-ui.test.js test/activity-mcp.smoke.test.js test/activity-local-monitor.integration.test.js test/activity-monitor-hardening.test.js
~~~

## Client and security limitations

MCP initialize instructions and tool descriptions are guidance, **not** a system prompt. A model may omit `activity_description`; the fallback still shows a useful generic status. The original proprietary hosted Remote Desktop Commander connector does **not** automatically expose these new fields merely because a modified local daemon is installed.

The display strips terminal escape/control characters and masks common secrets. Redaction is best-effort, not a guarantee against arbitrary sensitive data: never include credentials, access tokens, private file contents, or hidden reasoning in activity messages.

The local monitor uses IPC only; it opens no public network listener and makes no outbound tunnel connection. Remote MCP connectivity, runtime credentials, host restart behavior, and ChatGPT or Claude approvals are separate deployment concerns. See [production readiness](activity-production-readiness.md) before proposing a release.
