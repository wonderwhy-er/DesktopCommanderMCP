# MQTT shadow analytics

MQTT starts automatically in the background while Broadcast connects. No flag is needed
for shadow observation. Enrollment or MQTT failure leaves Broadcast working.

The `MQTT` branch records MQTT receipts without fetching, claiming or executing calls.
This holds whether `IS_MQTT_EXECUTION_ENABLED` is `false`, `true` or missing, and regardless
of cached rollouts. MQTT execution lives on the stacked `codex/mqtt-execution` branch.

The device advertises `transport_mqtt_v1` when MQTT is ready. The backend requires it
even for shadow publications. This capability does not distinguish the two device
branches. Pair this branch
with the backend's shadow branch; an execution backend could otherwise select MQTT calls
that this device will not execute. Broadcast handles execution and pending-call recovery;
both reject rows whose stored `metadata.transport` is `mqtt_v1`.
MQTT reconnects only restore observation. Drain active MQTT execution calls before
switching an execution device to this branch.
`MQTT_TRANSPORT_ENABLED` gates backend MQTT publications and enrollment; when it is off,
the backend sends no MQTT command.

This receiver accepts only the three required identifiers plus the optional execution boolean.
It rejects packets containing `expires_at`, `notification_id`, `attempt_number`, or any other extra field.
Older MQTT pilot receivers require different envelopes and must be updated together with the backend:
disable MQTT execution, drain active calls, update both sides, then re-enable execution.
Broadcast retains its database-time conditional claim, ambiguous-claim readback and
recovery, with duplicate suppression. Every valid MQTT receipt is observed, including retries, with
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
This mirrors Broadcast results for shadow analytics; the backend must keep Broadcast
authoritative for these calls. The origin comes from the call's database metadata.
This runs independently of the result write and its Broadcast trigger.
Each attempt is observed, with at most three attempts, a five-second
PUBACK deadline, and one-/two-second waits. A failed MQTT publish cannot turn a stored result
into a failed tool call. Existing database recovery still covers lost notifications.

Enrollment uses `/device/mqtt/enroll` over HTTPS, with a local HTTP exception for
`localhost`, `127.0.0.1`, `[::1]`, and `mcp.localhost`. Local hostnames must resolve to this
computer. The device profile directory depends on the environment:

- `DC_ENV=staging`: `~/.desktop-commander-device-staging`.
- `DC_ENV=development`: `~/.desktop-commander-device-dev`.
- Otherwise, including unset: `~/.desktop-commander-device`.

Each directory contains `device.json` and its MQTT credentials in `.mqtt`.
`npm run device:start:local` sets `DC_ENV=development`; `npm run device:start:staging`
sets `DC_ENV=staging`. `NODE_ENV` and `IS_STAGING` do not affect the profile directory.
The directory uses mode 0700 and files use 0600. The private key never leaves
the device. On startup, enrollment compares the authenticated device ID (registered from
`device.json`) with `.mqtt/identity.json`. If only the device ID changed, it sends
`POST /device/mqtt/revoke` with `device_id` (current) and `previous_device_id` (cached),
using the existing session. The backend checks ownership and revokes the previous
Thing's certificates. Only after `{ "revoked": true }` does the connector remove
`certificate.json`, then `identity.json` containing the old private key, and enroll
with a new key. This also works when the old certificate response was never saved.

Failed revocation keeps both old files. Restart retries the revocation. If replacement
enrollment fails after revocation, restart reuses the new key. An unchanged device
reuses its credentials without either request. Backend/account mismatches and damaged
identity caches still require inspection. One process may enroll a profile at a time.
This flow does not run on logout or ordinary restart and does not revoke device rows.
The matching backend and its documented AWS permissions must be available first;
an older backend's 404 preserves the old files and leaves MQTT unavailable.
Established MQTT connections reconnect automatically. Renewal is separate work.

The broker defaults to `mqtts://a1vw7p0stdnykd-ats.iot.eu-west-1.amazonaws.com:8883`.
Set `MQTT_BROKER_URL` to override it; unset or empty values use the default for every backend.
Backend and device must use the same broker. Cached certificates for another broker are rejected.
Broker and certificate verification remain mandatory. MQTT shadow failure does not affect Broadcast readiness.
Supabase Presence remains part of device availability. MQTT readiness controls this
capability, without blocking Broadcast startup or reachability.

Run `node test/run-all-tests.js test-mqtt-config.js test-mqtt-shadow.js test-mqtt-doorbell.js mqtt-enrollment.test.js`
to build and check mutual TLS, shadow isolation, automatic nonblocking startup,
result retries, receipt telemetry and enrollment. These local fixtures do not prove
live AWS policy or fleet behavior.
