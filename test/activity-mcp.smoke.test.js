import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP exposes operational tools without AI status tools', { timeout: 20000 }, async () => {
    const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'dcmcp-activity-'));
    const client = new Client({ name: 'activity-smoke-test', version: '1.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(process.cwd(), 'dist/index.js')],
        cwd: process.cwd(),
        env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome,
            APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
            LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
            DC_REMOTE_DEVICE: 'true', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', NO_COLOR: '1' },
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(!tools.tools.some(t => t.name === 'report_activity'));
        assert.ok(tools.tools.some(t => t.name === 'list_directory'));
        const result = await client.callTool({
            name: 'list_directory', arguments: { path: isolatedHome, depth: 1 }
        });
        assert.notEqual(result.isError, true);
    } finally {
        await client.close().catch(() => {});
        await rm(isolatedHome, { recursive: true, force: true });
    }
});
