# Broadcast analytics: quick guide

1. Backend creates the existing call row; its existing trigger sends the Broadcast.
2. Each device captures callback-entry UTC and `performance.now()`. Only the targeted
   device with valid call identity records receipt; other user-channel subscribers do not.
3. Observe the existing atomic claim/fetch and its 500/1500 ms retry waits. If needed,
   observe the existing fallback read/claim. No database requests are added.
4. Observe child readiness, actual execution, and every result-write attempt. Record
   `execution_start` only after readiness, immediately before invoking the tool.
5. Batch observations through authenticated `POST /device/transport-observations`.
   Backend forwards event `broadcast` to the existing `/remote/collect` endpoint.
   Deploy compatible collector/backend support before this device update.

| Stage / operation | Meaning |
| --- | --- |
| `received` | Target callback arrival, including duplicate/late notifications. |
| `operation_start` / `operation_end` | One actual application request or local operation. |
| `claim_fetch` | Existing atomic UPDATE RETURNING; attempts 1–3, retry waits separate. |
| `fallback_read` / `fallback_claim` | Existing ambiguity recovery and device claim. |
| `executor_ready` / `executor` | Child availability/startup, then actual tool work. |
| `result_write` | Every terminal update, including the existing text-only fallback. |
| `execution_start` / `execution_finish` | Actual invocation and completion/failure. |
| `handling_rejected` | Duplicate, lost/unresolved claim, unavailable client or read failure. |

Every observation has `call_id`, `notification_id=call_id:broadcast:1`,
`attempt_number=1`, `observation_id`, `source_process_id`, UTC and monotonic time.
Operation pairs share `operation_id` and carry `operation_attempt`; these retries
are separate from notification attempts and analytics retries. `duration_ms` measures
local operations; `retry_wait_ms` measures the actual wait. No arguments/results,
credentials or raw errors are included. Failed operations use safe categorical reasons.

Execution is unchanged: expired rows are not newly filtered; ambiguous committed
claims remain unresolved; the existing fallback claim may still fail open on errors.
Legacy/direct row callers have no Broadcast receipt and produce no attributed events.
Provider-wide fan-out, background/auth/internal traffic and complete production request
counts are outside these observed call-path totals; they are unavailable, not zero.

Reporting is best effort: 1,000 queued observations, batches of 50 once per second,
three attempts, one request at a time, 5-second timeout. Overflow/retry loss accompanies
later events as `dropped_count`. At most 1,000 receipt identities live for 60 seconds;
crashes or eviction can remove evidence. Sign-out resets identity-bound observations.
`DESKTOP_COMMANDER_DISABLE_TELEMETRY=1/true/yes/on` and `telemetryEnabled=false`
disable reporting. The relay uses the configured authentication backend over HTTPS;
local HTTP tests require `BROADCAST_ANALYTICS_ALLOW_INSECURE_LOCAL=true` and an
allowlisted loopback hostname. Redirects are rejected; no collector token is on device.

Use monotonic differences only within one process lifetime. Wall-clock offsets cannot
prove exact one-way network delay. Backend's offline analyzer applies the documented
60-second reporting grace; missing receipt means unknown delivery, not confirmed loss.
Run `npm run test:broadcast:analytics` with Node 22. The companion backend tests
10 accounts ×20 devices concurrently with database/Realtime/cloud doubles. Local
checks do not prove production throughput or warehouse durability.
