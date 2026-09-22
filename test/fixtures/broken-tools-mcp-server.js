#!/usr/bin/env node

/**
 * Test fixture: a stdio MCP server that completes the handshake and then fails
 * at the tool layer.
 *
 * `initialize` is answered normally, so a client connects successfully and the
 * process looks alive. `tools/list` comes back as a JSON-RPC error, so anything
 * that actually exercises the tool layer fails.
 *
 * That is the shape issue #4 warns about one level down: proving a process
 * speaks MCP is not proving it can execute. Used by
 * test/test-remote-device-readiness.js. It lives under fixtures/ so the runner's
 * `test*.js` discovery skips it.
 */
import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }

    if (message.method === 'initialize') {
        send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'broken-tools-mcp-server', version: '1.0.0' }
            }
        });
        return;
    }

    if (message.method === 'tools/list' || message.method === 'tools/call') {
        send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: 'tool layer is not available' }
        });
        return;
    }

    // Notifications carry no id and need no reply.
    if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
});
