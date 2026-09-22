#!/usr/bin/env node

/**
 * Test fixture: a minimal stdio MCP server that dies in the middle of a tool
 * call, reproducing the shape of issue #658 (a large multi-image response kills
 * the local Desktop Commander child while the call is still in flight).
 *
 * Behaviour:
 *   - `initialize` gets a normal handshake response
 *   - the tool named CRASH_TOOL is accepted and then never answered: the process
 *     exits instead, which closes the stdio pipe under the waiting caller
 *   - the tool named NOISE_TOOL emits a well-formed JSON-RPC response for an id
 *     nobody asked for, then answers the call normally. The stray response makes
 *     the SDK raise a protocol-level error while the child stays perfectly
 *     healthy — the condition a disconnect handler must NOT mistake for death
 *   - every other tool answers normally, so a caller that restarts the child can
 *     be shown to recover
 *
 * Used by test/test-remote-inflight-call-fast-fail.js. Not a test itself — it
 * lives under fixtures/ so the runner's `test*.js` discovery skips it.
 */
import readline from 'node:readline';

/** Must match CRASH_TOOL in test/test-remote-inflight-call-fast-fail.js. */
const CRASH_TOOL = 'crash-mid-call';

/** Must match NOISE_TOOL in test/test-remote-inflight-call-fast-fail.js. */
const NOISE_TOOL = 'protocol-noise';

const PROTOCOL_VERSION = '2024-11-05';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return; // not our problem — the caller under test owns framing
    }

    if (message.method === 'initialize') {
        send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'dying-mcp-server', version: '1.0.0' }
            }
        });
        return;
    }

    if (message.method === 'tools/list') {
        // A real server answers this, and the connector now asks for it before
        // calling a restarted child usable.
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
        return;
    }

    if (message.method === 'tools/call') {
        if (message.params?.name === CRASH_TOOL) {
            // Take the call, then die without answering. The delay lets the
            // request settle into the caller's pending-response map first, so
            // the death lands on a genuinely in-flight call.
            setTimeout(() => process.exit(1), 50);
            return;
        }
        if (message.params?.name === NOISE_TOOL) {
            // A valid response carrying an id the caller never sent. The SDK
            // reports it through Protocol.onerror ("Received a response for an
            // unknown message ID") without the child being in any trouble.
            send({ jsonrpc: '2.0', id: 999999, result: {} });
        }
        send({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: 'fixture-ok' }] }
        });
        return;
    }

    // Notifications carry no id and need no reply; answer anything else emptily
    // so an unexpected request cannot stall the caller.
    if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
});
