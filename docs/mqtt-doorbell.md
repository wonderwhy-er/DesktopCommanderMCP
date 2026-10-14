# MQTT notifications

MQTT starts automatically in the background while Broadcast connects. No flag is needed
for shadow observation. Enrollment or MQTT failure leaves Broadcast working.

| `IS_MQTT_EXECUTION_ENABLED` | Notifications and handling |
| --- | --- |
| Unset / false | Broadcast executes; MQTT command/result notifications are observation only |
| Exactly `true` | MQTT executes and publishes results; Broadcast handlers do not process commands |

Set the same execution flag on backend and device, drain active calls and restart when
changing modes. `MQTT_TRANSPORT_ENABLED` is retired and ignored. In execution mode,
MQTT startup must succeed before the device is ready; there is no Broadcast fallback.
The backend's execution migration suppresses command/result Broadcast for MQTT call rows.

Both handlers share the existing database-time conditional claim and duplicate suppression.
Every valid MQTT receipt is observed before the mode/claim guard, including retries, with
`transport`, `call_id`, a unique observation ID and a UTC timestamp.
Device telemetry omits MQTT notification/attempt IDs and monotonic timestamps.
Telemetry uses the existing sender, privacy controls and opt-outs. Cross-process clocks
cannot establish exact one-way latency.

After a successful terminal database write, the device publishes `{ call_id }`
on `dc/mqtt/v1/users/{userId}/devices/{deviceId}/result-{origin_instance}` by default.
Set `IS_MQTT_RESULT_PAYLOAD_ENABLED=true` on the device to send `{ call_id, data: { status, result?, error_message? } }`.
Unset, false or any other value sends only `call_id` without serializing the result data.
Both flags are read once at startup from `mqtt/config.ts`; restart the device after changing them.
The result and error are the same sanitized values saved to the database. If the JSON exceeds AWS IoT's
128 KiB payload limit, only `{ call_id }` is sent. The backend currently reads only `call_id`, ignores `data`
and fetches the saved result. Deploy that tolerant backend receiver before enabling result payloads. The origin comes
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
Supabase Presence remains part of device availability; execution mode also requires MQTT readiness.

Run `npm run test:mqtt` for mutual TLS, mode isolation, automatic nonblocking startup,
result retries, receipt telemetry and enrollment checks. These local fixtures do not prove
live AWS policy or fleet behavior.
