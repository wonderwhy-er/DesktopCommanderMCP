#!/usr/bin/env node
// A tool call's transport telemetry says which part failed. A tool that ran,
// but whose result couldn't be saved, is "tool_call_completed" and not also
// "tool_call_failed"; the "failed" row is still written. A tool that failed is
// "tool_call_failed", never "tool_call_completed". A call that works is
// "tool_call_completed" only.
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { configManager } from '../dist/config-manager.js';
import { MCPDevice } from '../dist/remote-device/device.js';

const DEVICE_ID = 'device-1';

// Every telemetry body this process would send
const sent = [];
const stagesOf = callId => sent.flatMap(body => body.events)
    .filter(event => event.params?.call_id === callId)
    .map(event => event.name);

/** Handles one tool call on a device whose tool and result save fail as asked; returns the call's transport stages and result rows. */
async function handle(callId, { toolThrows = false, saveThrows = false } = {}) {
    const writes = [];
    const device = new MCPDevice();
    device.deviceId = DEVICE_ID;
    device.desktop = {
        callClientTool: async () => {
            if (toolThrows) throw new Error('the tool failed');
            return { content: [{ type: 'text', text: 'ok' }] };
        },
    };
    device.remoteChannel = {
        markCallExecuting: async () => true,
        updateCallResult: async (id, status) => {
            writes.push(`${id}:${status}`);
            if (status === 'completed' && saveThrows) throw new Error('the result write failed');
        },
    };
    await device.handleNewToolCall({ new: { id: callId, tool_name: 'read_file', tool_args: {}, device_id: DEVICE_ID } });
    // Transport events aren't awaited: wait for the one the call ends with, then a little longer for any other
    const last = toolThrows ? 'tool_call_failed' : 'tool_call_completed';
    for (let waited = 0; waited < 3000 && !stagesOf(callId).includes(last); waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    return { stages: stagesOf(callId), writes };
}

const originalRequest = https.request;
const originalGetValue = configManager.getValue;
const originalGetOrCreateClientId = configManager.getOrCreateClientId;
const originalDisableTelemetry = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
try {
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
    assert.ok(saveFails.stages.includes('tool_call_completed'),
        `a tool that ran should be reported as completed: ${saveFails.stages.join(', ')}`);
    assert.ok(!saveFails.stages.includes('tool_call_failed'),
        `a tool that ran, whose result couldn't be saved, was also reported as failed: ${saveFails.stages.join(', ')}`);
    assert.deepEqual(saveFails.writes, ['call-save-fails:completed', 'call-save-fails:failed'],
        'after the result save failed, the "failed" row should still be written');

    const toolFails = await handle('call-tool-fails', { toolThrows: true });
    assert.ok(toolFails.stages.includes('tool_call_failed'),
        `a tool that failed should be reported as failed: ${toolFails.stages.join(', ')}`);
    assert.ok(!toolFails.stages.includes('tool_call_completed'),
        `a tool that failed was reported as completed: ${toolFails.stages.join(', ')}`);
    assert.deepEqual(toolFails.writes, ['call-tool-fails:failed']);

    const works = await handle('call-works');
    assert.deepEqual(works.stages.filter(stage => stage.startsWith('tool_call_')), ['tool_call_completed']);
    assert.deepEqual(works.writes, ['call-works:completed']);
} finally {
    https.request = originalRequest;
    syncBuiltinESMExports();
    configManager.getValue = originalGetValue;
    configManager.getOrCreateClientId = originalGetOrCreateClientId;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = originalDisableTelemetry;
}
console.log('PASS tool-call transport telemetry: a failed result save is completed, not failed; a failed tool is failed');
