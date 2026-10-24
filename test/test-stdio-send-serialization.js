import assert from 'assert';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FilteredStdioServerTransport } from '../dist/custom-stdio.js';

const message = (id) => ({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: { level: 'info', data: `message-${id}` },
});

async function testBackpressureSerialization() {
  const realWrite = process.stdout.write;
  const writes = [];
  process.stdout.write = function (chunk) {
    writes.push(String(chunk));
    return false;
  };

  const transport = new FilteredStdioServerTransport();
  let settled = 0;
  let maxDrainListeners = 0;

  try {
    const sends = Array.from({ length: 12 }, (_, id) =>
      transport.send(message(id)).then(() => { settled += 1; })
    );

    await new Promise((resolve) => setImmediate(resolve));
    maxDrainListeners = Math.max(maxDrainListeners, process.stdout.listenerCount('drain'));

    for (let i = 0; i < 20 && settled < sends.length; i++) {
      process.stdout.emit('drain');
      await new Promise((resolve) => setImmediate(resolve));
      maxDrainListeners = Math.max(maxDrainListeners, process.stdout.listenerCount('drain'));
    }

    await Promise.all(sends);

    assert.strictEqual(
      maxDrainListeners,
      1,
      `stdio transport should have at most one concurrent drain listener; observed ${maxDrainListeners}`
    );
    assert.deepStrictEqual(
      writes.map((line) => JSON.parse(line).params.data),
      Array.from({ length: 12 }, (_, id) => `message-${id}`),
      'serialized sends must preserve message order'
    );
  } finally {
    transport.cleanup();
    process.stdout.write = realWrite;
  }
}

async function testQueueRecoversAfterFailure() {
  const originalSend = StdioServerTransport.prototype.send;
  let sendAttempts = 0;

  StdioServerTransport.prototype.send = async function () {
    sendAttempts += 1;
    if (sendAttempts === 1) throw new Error('synthetic stdio write failure');
  };

  const transport = new FilteredStdioServerTransport();
  try {
    await assert.rejects(
      transport.send(message('fails')),
      /synthetic stdio write failure/
    );
    await transport.send(message('recovers'));
    assert.strictEqual(sendAttempts, 2, 'a failed send must not poison the queue for later sends');
  } finally {
    transport.cleanup();
    StdioServerTransport.prototype.send = originalSend;
  }
}

await testBackpressureSerialization();
await testQueueRecoversAfterFailure();
process.stderr.write('PASS: stdio backpressure keeps one drain listener, preserves order, and recovers after failure\n');
