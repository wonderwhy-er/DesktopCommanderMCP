# MQTT doorbell receiver

Both notification handlers use the same database-time claim, duplicate suppression, execution, and result-write path. MQTT messages contain identifiers only; tool arguments come from `mcp_remote_calls`.

| `MQTT_TRANSPORT_ENABLED` | Command handling |
| --- | --- |
| unset / false | MQTT is off; Broadcast executes |
| true | MQTT connects and executes; Broadcast receipts emit telemetry but cannot execute |

Only the literal value `true` enables MQTT. This is the only MQTT environment setting; restart the device after changing it. The selected handler runs the existing conditional `pending` → `executing` update with a database-time deadline. Duplicate MQTT packets cannot claim a row twice. Reconnect recovery remains available for missed notifications.

MQTT receipt emits the existing `received` transport event with `transport: mqtt` and `call_id`. Telemetry uses the existing privacy and opt-out controls.

With transport enabled, the authenticated device enrolls through `/device/mqtt/enroll` over HTTPS and stores its locally generated key and certificate beside the existing device profile, in `<profile>.mqtt` (directory mode 0700, files 0600). The private key never leaves the device. Credentials are bound to the backend, user, and device; damaged or mismatched caches fail instead of silently reenrolling. Certificate revocation and automatic renewal are separate work.

Broker URLs are fixed in `src/remote-device/config.ts` and selected by the authenticated MCP backend hostname. Staging (`staging-mcp.desktopcommander.app`) uses `mqtts://a1vw7p0stdnykd-ats.iot.eu-west-3.amazonaws.com:8883`. Production (`mcp.desktopcommander.app`) has a separate entry, currently unset until its endpoint is supplied; MQTT startup reports that configuration gap and never falls back to staging. Other backend hosts are rejected.

Users do not configure certificate files, broker overrides, or a custom trust store. Enrollment supplies the certificate, and the device keeps its private key locally; the returned/cached broker must match the configured endpoint. Connections require `mqtts://` with the enrolled client certificate and normal broker certificate verification. Enrollment or connection failure stops startup; there is no automatic switch to Broadcast.

The exact subscribed topic is `dc/mqtt/v1/users/{userId}/devices/{deviceId}/new_call`. The receiver checks topic, user/device identity, envelope size/shape, and rejects retained replay. It advertises `transport_mqtt_v1` and `transport_mqtt_observability_v1` after QoS 1 subscription succeeds, and withdraws them on disconnect. Supabase Presence remains required by the existing server selection flow. MQTT execution mode also requires a live MQTT subscription before advertising the device online; it does not fall back to Broadcast during an MQTT outage.

This first branch covers **incoming command doorbells**. Result writes are unchanged; MQTT result publication is a follow-up. If the backend suppresses result Broadcast for `mqtt_v1` rows, it currently retrieves those terminal rows through its recovery poll. Enable this device flag only with a backend configured to publish MQTT commands for the device.

Run `npm run test:mqtt` for local mutual-TLS MQTT, claim, telemetry, and enrollment checks. The test supplies an ephemeral CA directly to its connection options. The broker, certificates, database double, and telemetry endpoint are local test fixtures; these checks do not prove live AWS policy or fleet behavior.
