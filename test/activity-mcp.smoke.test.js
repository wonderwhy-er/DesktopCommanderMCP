import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

test('MCP installation advertises activity tool without manual prompt', { timeout: 20000 }, async () => {
    const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'dcmcp-activity-'));
    const client = new Client({ name: 'activity-smoke-test', version: '1.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(process.cwd(), 'dist/index.js')],
        cwd: process.cwd(),
        env: { ...process.env, HOME: isolatedHome, DC_REMOTE_DEVICE: 'true',
            DC_DISABLE_TELEMETRY: 'true', NO_COLOR: '1' },
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(tools.tools.some(t => t.name === 'report_activity'));
        let received = null;
        client.setNotificationHandler(LoggingMessageNotificationSchema, async (notice) => {
            if (notice.params.logger === 'desktop-commander.activity') received = notice.params.data;
        });
        const result = await client.callTool({
            name: 'report_activity',
            arguments: { phase: 'plan', message: 'Bir dosya incelenecek' }
        });
        assert.notEqual(result.isError, true);
        assert.deepEqual(received, { phase: 'plan', message: 'Bir dosya incelenecek' });
        assert.match(result.content[0].text, /accepted/);
    } finally {
        await client.close().catch(() => {});
        await rm(isolatedHome, { recursive: true, force: true });
    }
});
