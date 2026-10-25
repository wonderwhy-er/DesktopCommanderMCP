/**
 * Tests for UI event tracking plumbing between apps and host interfaces. It verifies expected event envelopes so telemetry and diagnostics remain stable.
 */
import assert from 'assert';

import { server } from '../dist/server.js';
import { buildTrackUiEventCapturePayload } from '../dist/handlers/history-handlers.js';
import { createToolBridge } from '../dist/ui/shared/tool-bridge.js';
import { createUiEventTracker } from '../dist/ui/shared/ui-event-tracker.js';
import { runIfMain } from './helpers/run-if-main.js';

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

async function testCanonicalWidgetCallKeys() {
  console.log('\n--- Test: canonical widget keys preserve distinct values ---');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = createToolBridge({
    host: { openai: { callTool: async () => { calls++; await gate; return {}; } } },
  });

  const reorderedA = bridge.callTool('read_file', { options: { offset: 0, length: 1 } });
  const reorderedB = bridge.callTool('read_file', { options: { length: 1, offset: 0 } });
  const nanCall = bridge.callTool('read_file', { value: Number.NaN });
  const nullCall = bridge.callTool('read_file', { value: null });
  release();
  await Promise.all([reorderedA, reorderedB, nanCall, nullCall]);

  assert.strictEqual(calls, 3, 'reordered keys coalesce, while NaN and null remain distinct');
  console.log('✓ canonical keys coalesce only equivalent requests');
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

async function testUiEventCacheStaysBounded() {
  console.log('\n--- Test: UI event cache stays bounded ---');
  const originalNow = Date.now;
  Date.now = () => 1_000;
  try {
    const calls = [];
    const track = createUiEventTracker(
      async (_name, args) => { calls.push(args); return {}; },
      { component: 'test-widget' },
    );

    for (let index = 0; index < 101; index++) track('click', { index });
    track('click', { index: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.strictEqual(calls.length, 102, 'oldest unique event should be evicted once the cache exceeds 100');
  } finally {
    Date.now = originalNow;
  }
  console.log('✓ unique-event bursts retain at most 100 dedupe keys');
}

async function testRefreshedUiEventRetainsRecency() {
  console.log('\n--- Test: refreshed UI event retains cache recency ---');
  const originalNow = Date.now;
  let now = 1_000;
  const calls = [];
  Date.now = () => now;
  try {
    const track = createUiEventTracker(
      async (_name, args) => { calls.push(args); return {}; },
      { component: 'test-widget' },
    );

    // The oldest key expires before any of the other 99 entries.
    // After refreshing it, a 101st entry must evict an older key instead.
    track('click', { index: 0 }); // t=1000
    now = 1_100;
    for (let index = 1; index < 100; index++) track('click', { index });
    now = 1_251; // key 0 expired; keys 1-99 are still within the window
    track('click', { index: 0 }); // refresh accepted, now should be newest
    track('click', { index: 100 }); // capacity eviction must spare key 0
    const acceptedCalls = calls.length;
    track('click', { index: 0 }); // immediate duplicate of refreshed entry
    assert.strictEqual(calls.length, acceptedCalls, 'recently refreshed event must remain suppressed');
  } finally {
    Date.now = originalNow;
  }
  console.log('✓ renewed cache keys retain their recency during eviction');
}

export default async function runTests() {
  try {
    await testTrackUiEventCall();
    await testTrackUiEventPayloadCollisionProtection();
    await testConcurrentWidgetCallsAreCoalesced();
    await testSequentialWidgetCallsRunAgain();
    await testCanonicalWidgetCallKeys();
    await testDuplicateUiEventsAreSuppressed();
    await testUiEventCacheStaysBounded();
    await testRefreshedUiEventRetainsRecency();
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

runIfMain(import.meta.url, runTests);
