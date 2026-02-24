# macOS Control in Desktop Commander MCP

This guide covers the macOS Accessibility (AX) and Electron debugger control features added to Desktop Commander MCP.

## Overview

The implementation has two control paths:

1. Accessibility path (native apps and Electron UI chrome)
- Uses a native Swift helper (`macos-ax-helper`) to query and act on AX elements.
- Supports finding/clicking elements, typing, keypress, waiting for UI state, and batching actions.

2. Debugger path (Electron/Chromium web content)
- Uses Chrome DevTools Protocol (CDP) over WebSocket.
- Supports attach, JavaScript evaluation, and disconnect.

## New MCP tools

Accessibility tools:
- `macos_ax_status`
- `macos_ax_list_apps`
- `macos_ax_find`
- `macos_ax_click`
- `macos_ax_type`
- `macos_ax_key`
- `macos_ax_activate`
- `macos_ax_wait_for`
- `macos_ax_batch`

Electron debug tools:
- `electron_debug_attach`
- `electron_debug_eval`
- `electron_debug_disconnect`

## Native helper contract

`macos-ax-helper` reads one JSON request from `stdin` and returns one JSON response to `stdout`.

Request shape:
```json
{
  "requestId": "optional-id",
  "command": "list_elements",
  "args": {}
}
```

Success response:
```json
{
  "ok": true,
  "data": {},
  "meta": {"requestId": "optional-id", "durationMs": 12}
}
```

Error response:
```json
{
  "ok": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Accessibility permissions not granted",
    "details": {}
  },
  "meta": {"requestId": "optional-id", "durationMs": 9}
}
```

Current helper commands:
- `status`
- `list_apps`
- `list_elements`
- `click`
- `type_text`
- `press_key`
- `activate`
- `wait_for`

## Build helper binaries

From repo root:

```bash
./build-macos-helper.sh
```

Expected outputs:
- `bin/macos/macos-ax-helper-darwin-arm64`
- `bin/macos/macos-ax-helper-darwin-x64`

If only one architecture can be built on your machine, the script exits non-zero and prints guidance.

## Permissions setup

Grant Accessibility permission to the process running Desktop Commander MCP.

macOS path:
- System Settings -> Privacy & Security -> Accessibility

Use `macos_ax_status` to verify permission state and process identification details.

## Suggested usage flow

1. `macos_ax_status`
2. `macos_ax_list_apps`
3. `macos_ax_find` (app + text/role)
4. `macos_ax_click` (prefer by `id`)
5. `macos_ax_wait_for` when UI transitions are asynchronous
6. `macos_ax_batch` for multi-step flows

For Electron debug workflows:
1. Launch target with remote debugging enabled
2. `electron_debug_attach`
3. `electron_debug_eval`
4. `electron_debug_disconnect`

## Test steps

1. Build TypeScript:
```bash
npm run build
```

2. Run focused tests:
```bash
node test/test-macos-control.js
node test/test-electron-debug.js
```

3. Optional: run the full test suite:
```bash
npm test
```

## Optimization opportunities

- Keep a persistent helper process to avoid process spawn overhead per AX call.
- Add element path locators (`AXParent` chain) for stronger stale-ID recovery.
- Add incremental snapshot mode to avoid full tree scans on repeated `find`.
- Add richer CDP APIs (`DOM.querySelector`, click/type helpers) on top of `electron_debug_eval`.
