# DesktopCommanderMCP Architecture (High Level)

This document describes the runtime shape of `DesktopCommanderMCP` and the core request lifecycle.

## What This Is

DesktopCommanderMCP is an MCP server that exposes tools for:
- Terminal/process execution
- Filesystem read/write/edit/search
- Skills orchestration (optional, behind config gates)
- Tool-call history and basic telemetry

Key entrypoint and wiring:
- `src/server.ts` (MCP server, request handlers, tool registry/filtering, guardrails, dispatch)
- `src/index.ts` / `dist/index.js` (runtime entrypoint; starts the MCP server over stdio)
- `server.yaml` (deployment/config surface: allowed directories, network toggles, timeouts)

## Components (Mapped to Real Code)

### MCP Server ("Town Hall")
- Constructed in `src/server.ts` via `new Server(...)`.
- Owns request handlers for MCP methods like `tools/list`, `tools/call`, resources, and prompts.

### Guardrails + Config ("Gatekeeper")
- `preExecutionGuardrail(toolName, args)` in `src/server.ts` blocks certain operations before dispatch.
- `server.yaml` exposes operator-facing config:
  - `ALLOWED_DIRECTORIES` (filesystem allowlist)
  - `DISABLE_NETWORK` and `NETWORK_TIMEOUT` (outbound network policy for containerized runs)

### Tool Registry + Filtering ("Toy Catalog")
- Tools are built as an in-memory array in `src/server.ts` in the `tools/list` handler.
- `shouldIncludeTool(toolName, skillsEnabled)` filters tools based on:
  - `currentClient` (e.g., hide feedback tool for desktop-commander client)
  - config `skillsEnabled` (hide skill tools unless explicitly enabled)

### Tool Dispatch ("Helpful Hands")
- `tools/call` handler in `src/server.ts`:
  1. Captures telemetry metadata (including optional `_meta.clientInfo`).
  2. Runs `preExecutionGuardrail(...)`.
  3. Dispatches to the correct handler (mostly in `src/handlers/*`).

### Tool-Call History ("Scrapbook")
- `src/utils/toolHistory.ts` exports `toolHistory`.
- `src/server.ts` appends tool calls via `toolHistory.addCall(name, args, result, duration)`,
  excluding `get_recent_tool_calls` and `track_ui_event` to avoid recursion/noise.

### Deferred Startup Logs ("Mail Carrier")
- `src/server.ts` buffers startup messages in `deferredMessages` and drains them via
  `flushDeferredMessages()` after initialization.
- `src/utils/toolHistory.ts` also uses a write queue (`writeQueue`) and periodic flush to
  append history to disk asynchronously (`tool-history.jsonl`).

## Request Lifecycle (tools)

### `tools/list`
1. Read config (`configManager.getConfig()`).
2. Build the full tools array (schemas + descriptions + annotations).
3. Filter tools via `shouldIncludeTool(...)`.
4. Return `{ tools: [...] }`.

### `tools/call`
1. Capture client metadata (optional) from `_meta`.
2. Run `preExecutionGuardrail(name, args)`; if blocked, return an error with `_meta.reason_code`.
3. Dispatch to the corresponding handler (`handlers.handleX(...)` or inline).
4. Record tool-call history via `toolHistory.addCall(...)` (with exclusions).

## "Bedtime Story" Glossary (Precise Mapping)

If you want the story version to be mechanically accurate, these are the exact anchors:
- Town Hall: `new Server(...)` in `src/server.ts`
- Gatekeeper: `preExecutionGuardrail(...)` in `src/server.ts` + `ALLOWED_DIRECTORIES` / `DISABLE_NETWORK` in `server.yaml`
- Toy Catalog: `tools/list` handler + `shouldIncludeTool(...)` in `src/server.ts`
- Helpful Hands: `tools/call` dispatch in `src/server.ts` and handlers in `src/handlers/*`
- Mail Carrier: `flushDeferredMessages()` in `src/server.ts` and async write queue in `src/utils/toolHistory.ts`
- Scrapbook: `toolHistory.addCall(...)` in `src/utils/toolHistory.ts` (invoked from `src/server.ts`)

