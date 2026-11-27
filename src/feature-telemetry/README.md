# Feature telemetry

`captureFeature(eventName, userId, { device_id, ...properties })` sends a feature
checkpoint to `/telemetry/feature/mcp/` on the existing telemetry hosts. Call it
with `void` when command handling must continue without waiting for telemetry.

The separate envelope contains `user_id`, the installation `client_id`, a UTC
timestamp captured at invocation, and one named event. Each event has `device_id`
and a generated `observation_id`; fallback reuses the same payload. Other JSON
properties use the existing telemetry privacy sanitizer. Callers must not pass
credentials, tool arguments, or tool results.

The sender honors the existing environment/configuration opt-outs and UI-origin
suppression. It tries the primary and fallback hosts with the existing three-second
timeout. Failures do not escape to the caller; delivery is best-effort.

This support is additive and has no production caller yet. Ordinary and transport
telemetry retain their existing endpoints and payloads. Deploy telemetry-proxy
[PR #10](https://github.com/desktop-commander/telemetry-proxy/pull/10) before releasing
callers of this helper; live endpoint availability has not been verified here.
The collector stores MCP account identity as null, so compare checkpoints using
`call_id` and `device_id`, and deduplicate fallback observations by `observation_id`.

Run `npm run build` and `node test/test-feature-telemetry.js` to check the sender.
