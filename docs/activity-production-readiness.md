# Native Activity Monitor - Release Validation

This is a native, English-only terminal interface for **real MCP tool events**. No model-authored explanation, chat transcript, code preview, raw command arguments, or tool results appear in the activity panel. Model-generated `activity_description` and `report_activity` have been removed from advertised MCP tools and initialization guidance.

## Implemented safeguards

- State is derived from actual MCP start/finish events; a successful operation is counted only after its completion event.
- Terminal input uses raw mode when interactive, consumes arrow/PageUp/PageDown/Home/End, handles SGR mouse wheel and Q/Ctrl+C, and restores terminal settings and mouse mode at exit.
- Rows remain within viewport and obey terminal resize. History is limited to 1000 operations; active calls limited to 4096 with visible overflow warning.
- No AI-authored or localized messages reach the UI. Readable English labels correspond to real tool names.
- Unix socket parent directory must be private to its owner. Stale sockets can be recovered without replacing another active monitor or a regular file.
- Logging is event-only, never a dump of arguments, source code, credentials or MCP results. UI is read-only and cannot authorize shell commands.
- Native UI preview can run independently of a production Remote Desktop Commander instance.

## Verification / quality gate

- Feature-specific unit, integration, and POSIX pseudo-terminal tests (including hundreds of arrow/mouse events and terminal settings restoration)
- Real stdio MCP calls to local filesystem tools using a temporary isolated HOME
- Full original project test suite run in an isolated checkout
- GitHub Actions builds and feature tests on Linux, macOS, and Windows with Node.js 22 and 24 (Windows IPC security validation remains a separate manual gate)
- Human terminal acceptance: narrow layouts, scroll anchoring, mouse wheel in tmux, user exits, resize, terminal state restoration

## Remaining production claims that require evidence

Do **not** claim a final production release until all platform checks are green and a maintainer has reviewed the change. A green test suite does not mean that crashes, security or remote connectivity incidents are impossible. A previously observed unrelated upstream reconnect test compared floating-point values `120000.00000000003` and `120000` exactly; triage it separately without modifying upstream infrastructure.

The screen is not an OpenAI tunnel supervisor. An external private tunnel may stop after reboot and requires user-approved service management. Do not automatically open or maintain a remote access tunnel simply to test this UI.

## Operator controls

`node dist/index.js activity`: run the local viewer. On Unix default IPC is `~/.cache/desktop-commander-activity/monitor.sock`. `DC_ACTIVITY_SOCKET` overrides the endpoint. Press Q to quit. Do not start another monitor on the same local socket.
