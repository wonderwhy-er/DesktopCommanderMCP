import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

import {
  createLazyPreviewState, createLazyStateFromLegacy, isLazyPreviewState,
} from '../dist/ui/file-preview/src/lazy-preview-state.js';

const fakeAppModule = [
  'export class App {',
  '  constructor() { this.calls=[]; this.host={hideSummaryRow:true,initiallyExpanded:true,displayMode:"inline",availableDisplayModes:["inline","fullscreen"]}; window.__dcApp=this; }',
  '  async connect() {}',
  '  getHostContext() {return this.host;}',
  '  async callServerTool({name, arguments:args}) {',
  '    this.calls.push({name,args});',
  '    if (name==="read_file") return {structuredContent:{fileName:"notes.txt",filePath:args.path,fileType:args.path.endsWith(".md")?"markdown":"text"},content:[{type:"text",text:"visible text"}]};',
  '    return {content:[]};',
  '  }',
  '  async requestDisplayMode({mode}) {this.host.displayMode=mode;return {mode};}',
  '  async openLink() {return {isError:false};}',
  '  async updateModelContext() {}',
  '}',
  'export function applyDocumentTheme() {}',
  'export function applyHostFonts() {}',
  'export function applyHostStyleVariables() {}',
].join('\n');

async function buildPreviewHarness() {
  const entry = fileURLToPath(new URL('../src/ui/file-preview/src/main.ts', import.meta.url));
  const output = await build({
    entryPoints: [entry],
    bundle: true, write: false, platform: 'browser', format: 'iife',
    target: ['es2020'], minify: true,
    plugins: [{
      name: 'test-ext-apps',
      setup(build) {
        build.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({ path: 'fake-ext-apps', namespace: 'test-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: fakeAppModule, loader: 'js' }));
      },
    }],
  });
  return output.outputFiles[0].text;
}

async function mount(bundle, persistedState) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'outside-only', url: 'https://example.test/widget',
  });
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.openai = {
    widgetState: persistedState,
    setWidgetState(value) { this.widgetState = value; },
  };
  dom.window.eval(bundle);
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return dom;
}

async function testDescriptorMetadata() {
  const partial = createLazyPreviewState({ path: '/docs/notes.md', offset: 2, length: 5 });
  assert.ok(isLazyPreviewState(partial));
  assert.deepEqual(partial.readArgs, { path: '/docs/notes.md', offset: 2, length: 5 });
  assert.equal(createLazyPreviewState({ path: '/docs/a.txt', length: 5000 }).readArgs.length, 5000,
    'idle core must not change the requested preview range');
  assert.equal(createLazyPreviewState({ path: '/docs/a.txt', offset: -500 }).readArgs.offset, -500,
    'idle core must preserve tail-read semantics');
  assert.deepEqual(
    createLazyPreviewState({ path: 'https://example.test', isUrl: true }).readArgs,
    { path: 'https://example.test', isUrl: true },
  );
  const legacy = createLazyStateFromLegacy({
    filePath: '/docs/notes.md', fileName: 'notes.md', fileType: 'markdown',
    content: '[Reading 5 lines from start (total: 100 lines, 95 remaining)]\n# Test',
  });
  assert.equal(legacy.readArgs.path, '/docs/notes.md');
  assert.equal(legacy.readArgs.length, 5);
  assert.equal(JSON.stringify(legacy).includes('# Test'), false, 'legacy content must not remain in widget state');
}
async function testOnDemandRuntime(bundle) {
  const dom = await mount(bundle, null);
  try {
    const { window } = dom;
    const app = window.__dcApp;
    assert.ok(app, 'app must connect to host');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0, 'initial mount must not read');
    for (let i = 0; i < 100; i++) {
      app.ontoolinput({ arguments: { path: '/tmp/notes.txt', offset: 0, length: 5 } });
      app.ontoolresult({ content: [{ type: 'text', text: 'model-side result' }] });
    }
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0, '100 unopened cards must not cause UI-origin reads');
    assert.ok(window.document.querySelector('.lazy-preview-open'), 'host-framed mode must show a clickable card');
    assert.ok(!window.document.getElementById('app').textContent.includes('visible text'), 'text must not be rendered while closed');
    assert.ok(isLazyPreviewState(window.openai.widgetState.payload), 'only descriptor is persisted');

    window.document.querySelector('.lazy-preview-open').click();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const reads = app.calls.filter(x => x.name === 'read_file');
    assert.equal(reads.length, 1, 'opening must cause exactly one UI-origin read');
    assert.equal(reads[0].args.origin, 'ui');
    assert.equal(reads[0].args.offset, 0);
    assert.equal(reads[0].args.length, 5);
    assert.ok(window.document.getElementById('app').textContent.includes('visible text'), 'content must be visible after opening');

    assert.ok(window.document.getElementById('close-preview-outer'), 'touch-friendly close control must remain visible');
    window.document.getElementById('close-preview-outer').click();
    assert.ok(window.document.querySelector('.lazy-preview-open'), 'close must restore lightweight card');
    assert.ok(!window.document.getElementById('app').textContent.includes('visible text'), 'close must destroy content DOM');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 1, 'closing must not cause a second read');

    window.document.querySelector('.lazy-preview-open').click();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const reopenedReads = app.calls.filter(x => x.name === 'read_file');
    assert.equal(reopenedReads.length, 2, 'reopening after close must cause exactly one fresh UI-origin read');
    assert.equal(reopenedReads[1].args.origin, 'ui');
    assert.ok(window.document.getElementById('app').textContent.includes('visible text'), 'content must be visible after reopening');
    window.document.getElementById('close-preview-outer').click();
    assert.ok(window.document.querySelector('.lazy-preview-open'), 'second close must return to lightweight card');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 2, 'second close must not add another read');

    const restored = await mount(bundle, window.openai.widgetState);
    try {
      assert.ok(restored.window.document.querySelector('.lazy-preview-open'), 'saved metadata must restore lightweight card');
      assert.equal(restored.window.__dcApp.calls.filter(x => x.name === 'read_file').length, 0, 'reload must not auto-read file');
    } finally { restored.window.close(); }
  } finally { dom.window.close(); }
}

async function testMarkdownOnDemand(bundle) {
  const dom = await mount(bundle, null);
  try {
    const app = dom.window.__dcApp;
    app.ontoolinput({ arguments: { path: '/tmp/notes.md', length: 3 } });
    app.ontoolresult({ content: [{ type: 'text', text: 'model read completed' }] });
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0, 'Markdown must remain idle until click');
    assert.equal(dom.window.document.getElementById('md-conflict-modal'), null, 'idle Markdown should not mount editor dialog');
    dom.window.document.querySelector('.lazy-preview-open').click();
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const reads = app.calls.filter(x => x.name === 'read_file');
    assert.equal(reads.length, 1, 'opening Markdown must not trigger an extra refreshFromDisk read');
    assert.equal(reads[0].args.length, 3, 'Markdown should preserve the original bounded range');
    assert.ok(dom.window.document.getElementById('md-conflict-modal'), 'editor dialog can mount after user interaction');
  } finally { dom.window.close(); }
}

async function testMutationWait(bundle) {
  const dom = await mount(bundle, null);
  try {
    const app = dom.window.__dcApp;
    app.ontoolinput({ arguments: { path: '/tmp/notes.txt', content: 'new file contents' } });
    const pending = dom.window.document.querySelector('.lazy-preview-open');
    assert.ok(pending.disabled, 'write_file preview must stay unavailable until mutation completes');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0);
    app.ontoolresult({ content: [{ type: 'text', text: 'saved' }] });
    const ready = dom.window.document.querySelector('.lazy-preview-open');
    assert.ok(!ready.disabled, 'successful mutation enables on-demand preview');
    ready.click();
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const calls = app.calls.filter(x => x.name === 'read_file');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.origin, 'ui');
  } finally { dom.window.close(); }
}

async function testLegacyMigration(bundle) {
  const legacy = { payload: { filePath: '/tmp/notes.txt', fileName: 'notes.txt', fileType: 'text', content: 'X'.repeat(300000) } };
  const dom = await mount(bundle, legacy);
  try {
    assert.ok(dom.window.document.querySelector('.lazy-preview-open'));
    assert.ok(isLazyPreviewState(dom.window.openai.widgetState.payload));
    assert.ok(JSON.stringify(dom.window.openai.widgetState).length < 500);
    assert.equal(dom.window.__dcApp.calls.filter(x => x.name === 'read_file').length, 0);
  } finally { dom.window.close(); }
}

export default async function runTests() {
  await testDescriptorMetadata();
  const bundle = await buildPreviewHarness();
  await testOnDemandRuntime(bundle);
  await testMarkdownOnDemand(bundle);
  await testMutationWait(bundle);
  await testLegacyMigration(bundle);
  console.log('PASS: file preview lazy card, single user-initiated read, unload, reload, legacy migration');
  return true;
}

runIfMain(import.meta.url, runTests);
