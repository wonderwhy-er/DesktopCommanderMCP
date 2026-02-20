/**
 * Tests for UI event tracking plumbing between apps and host interfaces. It verifies expected event envelopes so telemetry and diagnostics remain stable.
 */
import assert from 'assert';

import { server } from '../dist/server.js';
import { buildTrackUiEventCapturePayload } from '../dist/handlers/history-handlers.js';

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

export default async function runTests() {
  try {
    await testTrackUiEventCall();
    await testTrackUiEventPayloadCollisionProtection();
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
