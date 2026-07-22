/**
 * Tests for UI event tracking plumbing between apps and host interfaces. It verifies expected event envelopes so telemetry and diagnostics remain stable.
 */
import assert from 'assert';

import { server } from '../dist/server.js';
import { buildTrackUiEventCapturePayload } from '../dist/handlers/history-handlers.js';
import { createToolBridge } from '../dist/ui/shared/tool-bridge.js';
import { createUiEventTracker } from '../dist/ui/shared/ui-event-tracker.js';

function getRequestHandler(method) {
  const handlers = server._requestHandlers;
  assert.ok(handlers, 'Server request handlers should be initialized');
  const handler = handlers.get(method);
  assert.ok(handler, `Expected request handler for ${method}`);
  return handler;
}

async function testTrackUiEventCall() {
  console.log('\n--- Test: track_ui_event call ---');
  const callToolHandler = getRequestHandler('tools/call');
  const response = await callToolHandler({
    method: 'tools/call',
    params: {
      name: 'track_ui_event',
      arguments: {
        event: 'widget_expanded',
        component: 'file_preview',
        params: {
          file_type: 'markdown',
          line_count: 36,
          expanded: true
        }
      }
    }
  }, {});

  assert.ok(response, 'tools/call should return a response');
  assert.ok(Array.isArray(response.content), 'track_ui_event should return content array');
  assert.strictEqual(response.isError, undefined, 'track_ui_event should not return isError');
  assert.ok(response.content[0].text.includes('Tracked UI event'), 'track_ui_event should acknowledge event tracking');
  console.log('✓ track_ui_event call works');
}

async function testTrackUiEventPayloadCollisionProtection() {
  console.log('\n--- Test: track_ui_event payload collision protection ---');
  const payload = buildTrackUiEventCapturePayload('widget_expanded', 'file_preview', {
    event: 'spoofed',
    component: 'spoofed_component',
    line_count: 12
  });

  assert.strictEqual(payload.event, 'widget_expanded', 'Canonical event should override params.event');
  assert.strictEqual(payload.component, 'file_preview', 'Canonical component should override params.component');
  assert.strictEqual(payload.line_count, 12, 'Custom params should be preserved');
  console.log('✓ track_ui_event payload collision protection works');
}

async function testConcurrentWidgetCallsAreCoalesced() {
  console.log('\n--- Test: identical concurrent widget calls are coalesced ---');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = createToolBridge({
    host: {
      openai: {
        callTool: async () => {
          calls++;
          await gate;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
    },
  });

  const first = bridge.callTool('read_file', { path: 'same.txt', options: { offset: 0 } });
  const second = bridge.callTool('read_file', { options: { offset: 0 }, path: 'same.txt' });
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.strictEqual(calls, 1, 'equivalent in-flight requests should share one host call');
  assert.deepStrictEqual(a, b);
  console.log('✓ identical concurrent calls share one request');
}

async function testSequentialWidgetCallsRunAgain() {
  console.log('\n--- Test: sequential widget calls are not suppressed ---');
  let calls = 0;
  const bridge = createToolBridge({
    host: { openai: { callTool: async () => ({ call: ++calls }) } },
  });

  await bridge.callTool('get_config', {});
  await bridge.callTool('get_config', {});
  assert.strictEqual(calls, 2, 'request should run again after the prior call settles');
  console.log('✓ sequential calls execute normally');
}

async function testDuplicateUiEventsAreSuppressed() {
  console.log('\n--- Test: immediate duplicate UI events are suppressed ---');
  const calls = [];
  const track = createUiEventTracker(
    async (name, args) => { calls.push({ name, args }); return {}; },
    { component: 'test-widget' },
  );

  track('click', { target: 'refresh' });
  track('click', { target: 'refresh' });
  track('click', { target: 'other' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.strictEqual(calls.length, 2, 'duplicate should collapse while distinct event remains');
  console.log('✓ duplicate event collapsed without suppressing distinct event');
}

export default async function runTests() {
  try {
    await testTrackUiEventCall();
    await testTrackUiEventPayloadCollisionProtection();
    await testConcurrentWidgetCallsAreCoalesced();
    await testSequentialWidgetCallsRunAgain();
    await testDuplicateUiEventsAreSuppressed();
    console.log('\n✅ UI event tracking tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => {
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
