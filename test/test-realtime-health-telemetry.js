import assert from 'node:assert/strict';
import { RealtimeHealthTelemetry } from '../dist/remote-device/realtime-health-telemetry.js';

const emitted = [];
const health = new RealtimeHealthTelemetry((w) => emitted.push(w), () => 0.001);
health.setDevice('00000000-0000-4000-8000-000000000001');
health.newChannel();
health.record('join_successes');
health.record('presence_attempts');
health.record('presence_successes');
health.record('readiness_write_failures');
health.observeSocketState('open');
health.observeSocketState('closed');
const one = health.flush(Date.now() + 65_000);
assert.equal(one.explicit_subscribe_calls, 1);
assert.equal(one.join_successes, 1);
assert.equal(one.presence_attempts, 1);
assert.equal(one.readiness_write_failures, 1);
assert.equal(one.socket_disconnects, 1);
assert.equal(one.channel_generation, 1);
assert.match(one.device_diag_id, /^[a-f0-9]{32}$/);
assert.equal(one.process_session_id, health.processSessionId);
assert.ok(!JSON.stringify(one).includes('00000000-0000-4000-8000-000000000001'));
const two = health.flush(Date.now() + 130_000);
assert.equal(two.join_successes, 0);
assert.equal(two.explicit_subscribe_calls, 0);
assert.equal(emitted.length, 2);

const sampledOut = new RealtimeHealthTelemetry(() => { throw new Error('should not send'); }, () => 0.9);
sampledOut.setDevice('second');
sampledOut.record('join_timeouts');
assert.equal(sampledOut.flush(), null);
assert.equal(sampledOut.flush(), null);

const withThrowingSender = new RealtimeHealthTelemetry(() => { throw new Error('network'); }, () => 0);
withThrowingSender.setDevice('third');
assert.doesNotThrow(() => withThrowingSender.flush());
withThrowingSender.stop();
console.log('✅ Realtime diagnostic counters, sampling, and privacy passed');
