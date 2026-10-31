import assert from "node:assert/strict";
import { parseDeviceTransportPayload, parseRemoteTransportPayload } from "./transport.js";

const event = {
    name: "broadcast",
    params: {
        call_id: "call-1",
        stage: "received",
        transport: "broadcast",
        timestamp_utc: "2026-09-21T09:00:00Z",
        monotonic_ms: 12,
        device_id: "device-1",
        arrival_gap_ms: -5,
        source: "server",
        raw_args: "private",
    },
};
const remote = parseRemoteTransportPayload({ user_id: " user-1 ", events: [event] });
assert.equal(remote.user_id, "user-1");
assert.equal(remote.events[0].name, "received");
assert.equal(remote.events[0].params.arrival_gap_ms, -5);
assert.equal(remote.events[0].params.raw_args, undefined);
const device = parseDeviceTransportPayload({ client_id: "installation-1", events: [event] });
assert.equal(device.events[0].params.source, "device");
const withoutMonotonic = { ...event, params: { ...event.params } };
delete withoutMonotonic.params.monotonic_ms;
assert.equal(
    parseDeviceTransportPayload({ client_id: "installation-1", events: [withoutMonotonic] }).events[0].params.monotonic_ms,
    undefined,
);
assert.throws(
    () => parseDeviceTransportPayload({ client_id: "installation-1", events: [{ ...event, params: { ...event.params, device_id: "" } }] }),
    /Missing device_id/,
);
assert.throws(
    () => parseRemoteTransportPayload({ user_id: "user-1", events: [event, { ...event, params: { ...event.params, call_id: "" } }] }),
    /Invalid transport event property/,
);
console.log("PASS transport contract: backend and device identity, legacy names and atomic validation");
