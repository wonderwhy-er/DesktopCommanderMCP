#!/usr/bin/env node
// Each executed tool reports one outcome. A later result-write error does not change it.
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { configManager } from '../dist/config-manager.js';
import { MCPDevice } from '../dist/remote-device/device.js';

const DEVICE_ID = 'device-1';

// Every telemetry body this process would send
const sent = [];
const eventsOf = callId => sent.flatMap(body => body.events)
    .filter(event => event.params?.call_id === callId);

async function handle(callId, { toolThrows = false, saveThrows = false, toolResult = { content: [{ type: 'text', text: 'ok' }] } } = {}) {
    const writes = [];
    const beforeWrite = Date.now();
    const device = new MCPDevice();
    device.deviceId = DEVICE_ID;
    device.desktop = {
        callClientTool: async () => {
            if (toolThrows) throw new Error('the tool failed');
            return toolResult;
        },
    };
    device.remoteChannel = {
        user: { id: 'user-1' },
        markCallExecuting: async () => true,
        updateCallResult: async (id, status, result) => {
            mock.timers.tick(1); // Give each result write a distinct timestamp from the tool finishing.
            writes.push(`${id}:${status}`);
            if (status === 'completed') assert.deepEqual(result, toolResult);
            if (status === 'completed' && saveThrows) throw new Error('the result write failed');
        },
    };
    await device.handleNewToolCall({
        new: { id: callId, tool_name: 'read_file', tool_args: {}, device_id: DEVICE_ID,
            metadata: { transport: 'broadcast_v1' } },
    });
    // Transport delivery is asynchronous even though the device timestamps each event immediately.
    for (let waited = 0; waited < 3000 && !eventsOf(callId).some(event => event.name === 'tool_call_completed'); waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    const events = eventsOf(callId);
    for (const event of events) {
        assert.equal('IS_MQTT_EXECUTION_ENABLED' in event.params, false);
    }
    for (const body of sent.filter(body => body.events.some(event => event.params?.call_id === callId))) {
        assert.equal(body.telemetry_type, 'transport');
        assert.equal(body.user_id, 'user-1');
    }
    const terminalEvents = events.filter(event => event.name.startsWith('tool_call_'));
    assert.deepEqual(terminalEvents.map(event => event.name), ['tool_call_completed']);
    const { stage, outcome, timestamp_utc } = terminalEvents[0].params;
    assert.equal(stage, 'tool_call_completed');
    assert.equal(Date.parse(timestamp_utc), beforeWrite, 'tool completion must precede the result write that publishes it');
    return { outcome, writes };
}

const originalRequest = https.request;
const originalGetValue = configManager.getValue;
const originalGetOrCreateClientId = configManager.getOrCreateClientId;
const originalDisableTelemetry = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
try {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    configManager.getValue = async key => key === 'telemetryEnabled' ? true : undefined;
    configManager.getOrCreateClientId = async () => 'installation-1';
    https.request = (options, onResponse) => {
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.write = body => { sent.push(JSON.parse(body)); };
        request.end = () => {
            const response = new EventEmitter();
            response.statusCode = 204;
            response.resume = () => {};
            onResponse(response);
            queueMicrotask(() => response.emit('end'));
        };
        return request;
    };
    syncBuiltinESMExports();

    const saveFails = await handle('call-save-fails', { saveThrows: true });
    assert.equal(saveFails.outcome, 'success');
    assert.deepEqual(saveFails.writes, ['call-save-fails:completed', 'call-save-fails:failed'],
        'after the result save failed, the "failed" row should still be written');

    const toolFails = await handle('call-tool-fails', { toolThrows: true });
    assert.equal(toolFails.outcome, 'failed');
    assert.deepEqual(toolFails.writes, ['call-tool-fails:failed']);

    const errorReply = await handle('call-error-reply', {
        toolResult: { isError: true, content: [{ type: 'text', text: 'file not found' }] },
    });
    assert.equal(errorReply.outcome, 'failed');
    assert.deepEqual(errorReply.writes, ['call-error-reply:completed']);

    const works = await handle('call-works');
    assert.equal(works.outcome, 'success');
    assert.deepEqual(works.writes, ['call-works:completed']);
} finally {
    mock.timers.reset();
    https.request = originalRequest;
    syncBuiltinESMExports();
    configManager.getValue = originalGetValue;
    configManager.getOrCreateClientId = originalGetOrCreateClientId;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = originalDisableTelemetry;
}
console.log('PASS device tool completion reports one execution outcome per call');
