# MQTT notifications

MQTT starts automatically in the background while Broadcast connects. No flag is needed
for shadow observation. Enrollment or MQTT failure leaves Broadcast working.

| Command `IS_MQTT_EXECUTION_ENABLED` field | Notifications and handling |
| --- | --- |
| `false` | MQTT receipt is observation only; the Broadcast handler executes the stored Broadcast call |
| `true` | MQTT fetches and claims the call only when its stored `metadata.transport` is `mqtt_v1` |
| Missing | The stored call mode determines whether the MQTT handler may claim it |

The backend resolves `IS_MQTT_EXECUTION_ENABLED` from the user's rollouts, backend configuration,
and the selected device's MQTT capability for each dispatch. The four-field command contains this boolean alongside `call_id`, `user_id`,
and `device_id`. It stores the selected mode in `metadata.transport`. The device does not use its
cached execution rollout to choose execution, startup or reachability. MQTT always starts in the
background while Broadcast connects. `MQTT_TRANSPORT_ENABLED` gates backend MQTT publications and
enrollment; when it is off, the backend sends no MQTT command. There is no Broadcast fallback for MQTT calls.
The backend's execution migration suppresses command/result Broadcast for MQTT call rows.
Pending calls and retries retain their dispatch mode when rollouts change;
this decision needs no device rollout refresh. Drain active calls before removing their transport or rolling back that migration.

This receiver accepts only the three required identifiers plus the optional execution boolean.
It rejects packets containing `expires_at`, `notification_id`, `attempt_number`, or any other extra field.
Older MQTT pilot receivers require different envelopes and must be updated together with the backend:
disable MQTT execution, drain active calls, update both sides, then re-enable execution.
Without the execution boolean, it checks the stored call mode. Both handlers enforce that mode through
the existing database-time conditional claim, ambiguous-claim readback and recovery, with duplicate suppression.
Every valid MQTT receipt is observed before the mode/claim guard, including retries, with
`transport`, `call_id`, a unique observation ID and a UTC timestamp.
Device telemetry omits MQTT notification/attempt IDs and monotonic timestamps.
Telemetry includes the per-call `IS_MQTT_EXECUTION_ENABLED` boolean when known, preserving explicit `false`.
The collector's updated transport and command-event allowlists must be deployed before
this field appears in backend warehouse telemetry. The existing GA4-compatible schema
stores it as a `"true"`/`"false"` string under the exact uppercase key. Device telemetry
routing is unchanged.
Telemetry uses the existing sender, privacy controls and opt-outs. Cross-process clocks
cannot establish exact one-way latency.

After a successful terminal database write, the device publishes `{ call_id }`
on `dc/mqtt/v1/users/{userId}/devices/{deviceId}/result-{origin_instance}`.
The backend fetches the sanitized result or error from the database. The origin comes
from the call's database metadata. This runs independently of the result write and its
Broadcast trigger. Each attempt is observed, with at most three attempts, a five-second
PUBACK deadline, and one-/two-second waits. A failed MQTT publish cannot turn a stored result
into a failed tool call. Existing database recovery still covers lost notifications.

Enrollment uses `/device/mqtt/enroll` over HTTPS and stores the locally generated key and
certificate in `<profile>.mqtt` (directory 0700, files 0600). The private key never leaves
the device. Credentials are bound to backend/user/device; invalid caches are not replaced
silently. Initial enrollment is attempted once; fix configuration and restart on failure.
Established MQTT connections reconnect automatically. Renewal is separate work.

The broker defaults to `mqtts://a1vw7p0stdnykd-ats.iot.eu-west-1.amazonaws.com:8883`.
Set `MQTT_BROKER_URL` to override it; unset or empty values use the default for every backend.
Backend and device must use the same broker. Cached certificates for another broker are rejected.
Broker and certificate verification remain mandatory. MQTT shadow failure does not affect Broadcast readiness.
Supabase Presence remains part of device availability. MQTT readiness controls the capability the
backend requires for MQTT execution calls, without blocking Broadcast startup or reachability.

Run `npm run test:mqtt` for mutual TLS, mode isolation, automatic nonblocking startup,
result retries, receipt telemetry and enrollment checks. These local fixtures do not prove
live AWS policy or fleet behavior.
