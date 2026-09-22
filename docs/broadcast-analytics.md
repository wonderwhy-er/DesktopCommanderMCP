# Broadcast receipt observation

The device records one `broadcast` event when a targeted `new_call` callback enters. It captures UTC and `performance.now()` before the existing doorbell handler fetches or claims the call. The event carries `call_id`, `device_id`, `notification_id`, `attempt_number`, `observation_id`, and `source_process_id` for correlation with Remote MCP's dispatch observations. Duplicate callbacks produce separate receipts. Other devices on the per-user channel and malformed identifiers produce none.

The event uses Desktop Commander's existing `capture()` telemetry path. Its opt-out settings, HTTPS sender, and best-effort failure handling apply. No command or database request waits for telemetry, and no arguments, results, account ID, or bearer token are sent in the event. The public collector treats these device reports as unverified; they must stay separate from authenticated backend evidence.

UTC timestamps can show an approximate dispatch-to-receipt interval, but device and server clock skew prevents a precise one-way latency claim. `monotonic_ms` is meaningful only within this device process. A missing receipt is unknown delivery, not proof of loss.

Run `npm run test:broadcast:analytics` to check the receipt contract and target filtering. The collector's transport-event support must be deployed before analyzing these events.
