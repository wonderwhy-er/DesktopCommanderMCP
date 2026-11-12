import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/ext-apps';
import { getCompressedFilePreviewRuntime, getFilePreviewResourceText } from '../dist/ui/resources.js';
import { LITE_MCP_APPS_PROTOCOL_VERSION } from '../dist/ui/file-preview/src/lite-app.js';
import { runIfMain } from './helpers/run-if-main.js';

async function bundleLight() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/ui/file-preview/src/light-main.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    minify: true,
    target: ['es2020'],
  });
  return result.outputFiles[0].text;
}

function createDom(persisted, viewerB64) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously', url: 'https://example.test/widget', pretendToBeVisual: true,
  });
  dom.window.Blob = Blob;
  dom.window.__dcMeasuredWithFitContent = false;
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 320 });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { configurable: true, value: 320 });
  dom.window.document.documentElement.getBoundingClientRect = () => {
    dom.window.__dcMeasuredWithFitContent =
      dom.window.document.documentElement.style.width === 'fit-content'
      && dom.window.document.documentElement.style.height === 'fit-content';
    return { x: 0, y: 0, top: 0, right: 320, bottom: 44, left: 0, width: 320, height: 44, toJSON() {} };
  };
  dom.window.__dcResizeDisconnects = 0;
  dom.window.ResizeObserver = class {
    observe() {}
    disconnect() { dom.window.__dcResizeDisconnects += 1; }
  };
  dom.window.Response = Response;
  dom.window.DecompressionStream = DecompressionStream;
  dom.window.TextDecoder = TextDecoder;
  dom.window.TextEncoder = TextEncoder;
  dom.window.openai = {
    widgetState: persisted,
    setWidgetState(next) { this.widgetState = next; },
  };

  const host = { calls: [], initializeCount: 0, responses: [], notifications: [] };
  const send = (message) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: message, source: dom.window,
  }));
  host.notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  host.request = (id, method, params = {}) => send({ jsonrpc: '2.0', id, method, params });
  dom.window.postMessage = (message) => {
    if (message.id !== undefined && typeof message.method !== 'string') {
      host.responses.push(message);
      return;
    }
    if (message.method === 'ui/initialize') {
      host.initializeCount += 1;
      queueMicrotask(() => send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' },
        hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } },
        hostContext: {
          theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'],
          styles: { variables: { '--color-text-primary': 'rgb(1, 2, 3)' } },
        },
      }}));
      return;
    }
    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      host.calls.push({ name, args });
      const result = name === 'get_file_preview_runtime'
        ? { content: [{ type: 'text', text: viewerB64 }] }
        : name === 'read_file'
          ? { content: [{ type: 'text', text: 'loaded file contents' }] }
          : { content: [] };
      queueMicrotask(() => send({ jsonrpc: '2.0', id: message.id, result }));
      return;
    }
    if (message.method?.startsWith('ui/notifications/')) {
      host.notifications.push({ method: message.method, params: message.params });
      return;
    }
    if (message.id !== undefined) {
      host.responses.push(message.method);
      const result = message.method === 'ui/request-display-mode'
        ? { mode: message.params?.mode }
        : {};
      queueMicrotask(() => send({ jsonrpc: '2.0', id: message.id, result }));
    }
  };
  dom.window.__dcHost = host;
  return dom;
}

async function waitUntil(fn, timeout = 2500) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for File Preview');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

async function testSplitViewer() {
  assert.equal(LITE_MCP_APPS_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION,
    'lite bridge protocol version must track the installed ext-apps SDK');
  const initialHtml = await getFilePreviewResourceText();
  assert.ok(initialHtml.includes('get_file_preview_runtime'), 'thin shell must request viewer on click');
  assert.ok(Buffer.byteLength(initialHtml) < 100000, 'initial UI resource should stay below 100 kB');

  const encoded = await getCompressedFilePreviewRuntime();
  const full = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
  assert.ok(full.includes('__dcStartFilePreview'), 'returned viewer should expose hydration callback');
  assert.ok(full.length > initialHtml.length, 'heavy viewer must remain separate from the shell');

  const lightJs = await bundleLight();
  assert.ok(Buffer.byteLength(lightJs) < 20000, 'light JS should stay below 20 kB');
  const hydratorJs = `window.__dcStartFilePreview=(app)=>{
    window.__dcViewerStarts=(window.__dcViewerStarts||0)+1;
    window.__dcBridgeComplete=['callServerTool','updateModelContext','openLink','requestDisplayMode','getHostContext'].every(k=>typeof app[k]==='function');
    app.callServerTool({name:'read_file',arguments:{path:'/tmp/notes.txt',offset:0,length:5,origin:'ui'}}).then(result=>{
      document.getElementById('app').textContent=result.content?.[0]?.text||'';
    });
  };`;
  const viewerB64 = gzipSync(Buffer.from(hydratorJs, 'utf8')).toString('base64');
  const dom = createDom(null, viewerB64);
  try {
    dom.window.eval(lightJs);
    const host = dom.window.__dcHost;
    await waitUntil(() => host.initializeCount === 1
      && dom.window.document.querySelector('#app').textContent.includes('File preview available'));
    assert.equal(dom.window.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(dom.window.document.documentElement.style.getPropertyValue('--color-text-primary'), 'rgb(1, 2, 3)');
    await waitUntil(() => host.notifications.some(x => x.method === 'ui/notifications/size-changed'));
    const size = host.notifications.find(x => x.method === 'ui/notifications/size-changed')?.params;
    assert.equal(dom.window.__dcMeasuredWithFitContent, true, 'lite shell must measure intrinsic size like the official SDK');
    assert.equal(size?.width, 320);
    assert.equal(size?.height, 44, 'zero-height hosts must receive the visible card height');

    for (let i = 0; i < 100; i++) {
      host.notify('ui/notifications/tool-input', { arguments: { path: '/tmp/notes.txt', offset: 0, length: 5 } });
      host.notify('ui/notifications/tool-result', { content: [{ type: 'text', text: 'model result' }] });
    }
    assert.equal(host.calls.length, 0, 'unopened cards must not request runtime or file');
    assert.ok(dom.window.document.querySelector('.lazy-preview-open'));
    assert.equal(dom.window.openai.widgetState.payload.kind, 'desktop-commander-lazy-preview');

    dom.window.document.querySelector('.lazy-preview-open').click();
    await waitUntil(() => host.calls.some(c => c.name === 'read_file'));
    assert.equal(host.calls.filter(c => c.name === 'get_file_preview_runtime').length, 1);
    assert.equal(host.calls.filter(c => c.name === 'read_file').length, 1);
    assert.equal(host.calls.find(c => c.name === 'read_file').args.origin, 'ui');
    assert.equal(host.initializeCount, 1, 'hydrated viewer must reuse the existing connection');
    assert.equal(dom.window.__dcViewerStarts, 1);
    assert.equal(dom.window.__dcBridgeComplete, true);
    assert.ok(dom.window.document.getElementById('app').textContent.includes('loaded file contents'));

    const restored = createDom(dom.window.openai.widgetState, viewerB64);
    try {
      restored.window.eval(lightJs);
      await waitUntil(() => restored.window.document.querySelector('.lazy-preview-open'));
      assert.equal(restored.window.__dcHost.calls.length, 0, 'restored unopened card must stay idle');
      assert.equal(restored.window.__dcHost.initializeCount, 1);
      const restoredButton = restored.window.document.querySelector('.lazy-preview-open');
      const restoredTitle = restoredButton?.title;
      restored.window.__dcHost.request(99, 'ui/resource-teardown');
      await waitUntil(() => restored.window.__dcHost.responses.some(message => message.id === 99));
      assert.equal(Object.keys(restored.window.__dcHost.responses.find(message => message.id === 99)?.result ?? {}).length, 0);
      assert.equal(restored.window.__dcResizeDisconnects, 1, 'teardown must disconnect the lite ResizeObserver');
      restored.window.__dcHost.notify('ui/notifications/tool-input', { arguments: { path: '/tmp/after-teardown.txt' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(restored.window.document.querySelector('.lazy-preview-open')?.title, restoredTitle,
        'teardown must remove the message listener');
    } finally {
      restored.window.close();
    }
  } finally {
    dom.window.close();
  }

  console.log('UI_HTML_BYTES', Buffer.byteLength(initialHtml), 'LIGHT_JS_BYTES', Buffer.byteLength(lightJs),
    'COMPRESSED_VIEWER_BASE64_BYTES', encoded.length, 'FULL_VIEWER_BYTES', Buffer.byteLength(full));
}

export default async function runTests() {
  await testSplitViewer();
  console.log('PASS: sub-20k shell, click-only viewer, one MCP Apps connection, idle restore');
  return true;
}
runIfMain(import.meta.url, runTests);
