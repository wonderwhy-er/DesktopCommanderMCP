import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ActivityView } from '../dist/activity/activity.js';
import { createActivityMonitor } from '../dist/activity/channel.js';

test('AI text reaches the local TUI through a real stdio MCP session', { timeout: 25000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dcmcp-mon-'));
    const socket = path.join(home, 'private', 'events.sock');
    const chunks = [];
    const view = new ActivityView({ isTTY: false, write: data => chunks.push(data) });
    const monitor = await createActivityMonitor(view, socket);
    const client = new Client({ name: 'activity-integration-test', version: '1.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(process.cwd(), 'dist/index.js')],
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, DC_ACTIVITY_SOCKET: socket,
            DC_REMOTE_DEVICE: 'true', DC_DISABLE_TELEMETRY: 'true', NO_COLOR: '1' },
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        assert.match(client.getInstructions(), /report_activity/);
        const tools = await client.listTools();
        assert.ok(tools.tools.some(x => x.name === 'report_activity'));
        const directoryTool = tools.tools.find(x => x.name === 'list_directory');
        assert.equal(directoryTool.inputSchema.properties.activity_description.type, 'string');
        // No separate report_activity call: the model writes text in the SAME tool invocation.
        const actual = await client.callTool({ name: 'list_directory',
            arguments: { path: home, depth: 1, activity_description: 'Test klasöründeki dosyalar listeleniyor' } });
        assert.notEqual(actual.isError, true);
        // The stream sends an end event after the tool call, which is delivered asynchronously.
        for (let i = 0; i < 30 && view.getSnapshot()[0]?.state !== 'done'; i++) {
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        const events = view.getSnapshot();
        assert.equal(events.length, 1);
        assert.equal(events[0].ai, true);
        assert.equal(events[0].tool, 'list_directory');
        assert.equal(events[0].text, 'Test klasöründeki dosyalar listeleniyor');
        assert.equal(events[0].state, 'done');
        assert.ok(chunks.some(x => x.includes('Test klasöründeki dosyalar')));
    } finally {
        await client.close().catch(() => {});
        await monitor.close();
        await rm(home, { recursive: true, force: true });
    }
});
