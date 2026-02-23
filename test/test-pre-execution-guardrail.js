import assert from 'assert';
import { server } from '../dist/server.js';

function getRequestHandler(method) {
  const handlers = server._requestHandlers;
  assert.ok(handlers, 'Server request handlers should be initialized');
  const handler = handlers.get(method);
  assert.ok(handler, `Expected request handler for ${method}`);
  return handler;
}

async function run() {
  const callToolHandler = getRequestHandler('tools/call');

  {
    const res = await callToolHandler(
      {
        method: 'tools/call',
        params: {
          name: 'set_config_value',
          arguments: { key: 'toolCallLoggingMode', value: 'definitely-not-a-mode' }
        }
      },
      {}
    );

    assert.strictEqual(res.isError, true, 'Expected guardrail to reject invalid config enum values');
    assert.strictEqual(res._meta?.reason_code, 'invalid_arguments', 'Expected invalid_arguments reason code');
    assert.ok(
      (res.content?.[0]?.text || '').includes('Invalid value for toolCallLoggingMode'),
      'Expected an invalid value message'
    );
  }

  {
    const res = await callToolHandler(
      {
        method: 'tools/call',
        params: {
          name: 'start_process',
          arguments: { command: 'rm -rf /' }
        }
      },
      {}
    );

    assert.strictEqual(res.isError, true, 'Expected guardrail to block destructive start_process');
    assert.strictEqual(res._meta?.reason_code, 'disallowed_operator', 'Expected disallowed_operator reason code');
    assert.ok(
      (res.content?.[0]?.text || '').toLowerCase().includes('blocked by safety guardrail'),
      'Expected a safety guardrail message'
    );
  }

  console.log('test-pre-execution-guardrail: PASS');
}

run().catch((error) => {
  console.error('test-pre-execution-guardrail: FAIL', error);
  process.exit(1);
});

