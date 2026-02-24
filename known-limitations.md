# Known Limitations

## Accessibility path

- macOS-only: AX tools return unsupported platform on non-macOS hosts.
- Requires explicit Accessibility permission for the MCP host process.
- AX trees differ by app and can be incomplete or unstable in custom UI frameworks.
- Stable IDs are best-effort hashes of visible properties; some dynamic UIs can invalidate them quickly.
- Stale-ID fallback depends on prior element signatures and may fail in heavily changing layouts.

## Electron/CDP path

- Requires app/browser launched with remote debugging endpoint enabled.
- Current CDP tool set is intentionally minimal: attach/eval/disconnect.
- DOM interaction helpers are not yet first-class MCP tools (can be done via JavaScript in `electron_debug_eval`).

## Packaging/build

- Native helper binaries are architecture-specific (`darwin-arm64`, `darwin-x64`).
- Building both architectures from one machine may require additional toolchain support.
