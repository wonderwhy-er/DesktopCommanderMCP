# MQTT notifications

MQTT starts automatically in the background while Broadcast connects. No flag is needed
for shadow observation. Enrollment or MQTT failure leaves Broadcast working.

| `MQTT_EXECUTION_ENABLED` | Notifications and handling |
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

After a successful terminal database write, the device publishes an identifier-only result
on `dc/mqtt/v1/users/{userId}/devices/{deviceId}/result-{origin_instance}`. The origin comes
from the call's database metadata. This runs independently of the result write and its
Broadcast trigger. Each attempt is observed, with at most three attempts, a five-second
PUBACK deadline, and one-/two-second waits. A failed MQTT publish cannot turn a stored result
into a failed tool call. Existing database recovery still covers lost notifications.

Enrollment uses `/device/mqtt/enroll` over HTTPS and stores the locally generated key and
certificate in `<profile>.mqtt` (directory 0700, files 0600). The private key never leaves
the device. Credentials are bound to backend/user/device; invalid caches are not replaced
silently. Initial enrollment is attempted once; fix configuration and restart on failure.
Established MQTT connections reconnect automatically. Renewal is separate work.

Broker URLs are selected by the authenticated backend in `src/remote-device/config.ts`.
Staging is configured; production's separate endpoint is currently unset and must be supplied
before production MQTT can connect. It never falls back to staging. Broker and certificate
verification remain mandatory. MQTT shadow failure does not affect Broadcast readiness.
Supabase Presence remains part of device availability; execution mode also requires MQTT readiness.

Run `npm run test:mqtt` for mutual TLS, mode isolation, automatic nonblocking startup,
result retries, receipt telemetry and enrollment checks. These local fixtures do not prove
live AWS policy or fleet behavior.
