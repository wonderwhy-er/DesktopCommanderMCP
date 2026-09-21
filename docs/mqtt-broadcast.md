# MQTT and Broadcast: quick guide

1. Start with `MQTT_TRANSPORT_ENABLED=true`, `MQTT_EXECUTION_ENABLED=false`.
   Both arrive; only Broadcast executes. Both true selects MQTT execution.
   Transport false/unset disables all MQTT and ignores execution=true. Restart for flag changes.
2. Backend always keeps Broadcast; it also sends MQTT only when its master flag is
   enabled and the device has subscribed. Execution preference stays on this device.
3. Each notification points to the same durable call. Observe receipt before expiry,
   source selection, fetch and claim. Only the selected source can execute; no fallback.
4. After successful claim and final checks, record execution immediately before the tool.
   A delayed duplicate or other transport remains observable after execution completes.
5. Roll out the compatible collector/backend first, then shadow connectors, then MQTT
   execution. Roll back device execution to Broadcast before disabling backend MQTT.

## Events and timing

Events `mqtt` / `broadcast` use stages:

| Location | Stage | Meaning |
| --- | --- | --- |
| Backend | `tool_call_received` | Tool processing starts. |
| Backend | Broadcast `dispatch_start` | Immediately before database insert, not socket send. |
| Backend | MQTT `send_attempt` | Publication starts; acknowledgement is broker acceptance. |
| Device | `received` | Callback-entry `performance.now()` and UTC, before expiry filtering. |
| Device | `execution_skipped` | `observation_only`: source is not selected. |
| Device | `handling_rejected` | `expired`, `duplicate`, `concurrency_limit`, `claim_lost`, `invalid_row`, `unavailable`. |
| Device | `execution_start` | Actual tool boundary, after claim and child startup/admission. |

All observations carry `call_id`, `notification_id`, `attempt_number`, `observation_id`,
`source_process_id`, `transport`, `stage`, `schema_version`, `timestamp_utc`, `monotonic_ms`.
Execution/rejection `duration_ms` is measured since this receipt. `arrival_gap_ms` is
first MQTT arrival minus first Broadcast arrival (positive means MQTT later).
`duplicate_count` counts repeat notification identities within the observation window;
new application attempts are not duplicates.

Use monotonic differences only inside one process. UTC correlates logs; unsynchronized
machine clocks cannot prove absolute one-way latency. Existing auth clock correction
is not precision calibration. Broadcast's pre-insert start includes database latency.

MQTT application retries get new notification IDs; QoS retransmissions retain them.
Old MQTT envelopes and Broadcast derive `call_id:transport:1`; separate republications
cannot be distinguished. Retried telemetry keeps its `observation_id` for deduplication.

## Failures and telemetry

- `publish_error` / `publish_ack_timeout`: backend publication trouble; receipt may still occur.
- `insert_failed`: backend database insertion failed; not proof Broadcast was sent.
- `receipt_observed`: notification arrived, including observation-only or rejected messages.
- `receipt_not_observed_by_deadline`: backend lacks receipt evidence, not confirmed network loss.
- `not_sent_disabled` / `not_sent_not_ready`: no MQTT attempt; exclude from failure rates.
- Late delivery and late analytics differ. `expired` is the device's deadline decision;
  it is not proof of synchronized-clock one-way latency.
- Telemetry gaps are separate: `dropped_count` accompanies the next observation; malformed
  uncorrelatable messages use a local aggregate counter. A crash can lose buffered events.

Device telemetry uses authenticated `POST /device/transport-observations`, never the
collector token. Backend forwards to `/remote/collect`; no tool arguments/results.
At most 1,000 queued events; batches of 50 every second; 3 attempts per batch; 5-second
request timeout. Overflow drops new observations. Up to 1,000 calls retain first receipts
for 60 seconds, including completed calls, with 128 notification identities per call;
capacity eviction limits comparison and duplicate-count coverage.
Sign-out clears identity-bound state and cancels pending reporting; shutdown stops timers.
`DESKTOP_COMMANDER_DISABLE_TELEMETRY=1/true/yes/on` or the existing
`telemetryEnabled=false` setting disables reporting. MQTT shadow connection
failures leave Broadcast execution available; active mode never silently falls back.

## Local checks

`npm run build && npm run test:mqtt` (Node 22). Includes flag matrix, real local MQTT,
late/invalid envelopes, claims, clock jumps, telemetry loss/retries and teardown.
The backend companion harness runs 10 accounts × 20 devices concurrently. Its MQTT is
real loopback; database/Supabase and local tools are doubles. No Production capacity or
BigQuery delivery claim; collector capacity/SLOs remain rollout gates.
