import assert from 'assert';

import { renderDirectoryBody } from '../dist/ui/file-preview/src/directory-controller.js';
import { runIfMain } from './helpers/run-if-main.js';

async function testDirectoryBodyRendering() {
  console.log('\n--- Test: directory preview rendering ---');

  const listing = [
    'Directory listing for /tmp/project',
    '[DIR] docs',
    '[FILE] docs/readme.md',
    '[WARNING] docs: 8 items hidden (showing first 2 of 10 total)',
    '[DENIED] secrets',
  ].join('\n');

  const result = renderDirectoryBody(listing, '/tmp/project');
  assert.strictEqual(result.notice, 'Directory listing for /tmp/project');
  assert.ok(result.html.includes('dir-tree'), 'Directory preview should render the tree shell');
  assert.ok(result.html.includes('dir-row-folder'), 'Directory preview should render folder rows');
  assert.ok(result.html.includes('dir-row-file'), 'Directory preview should render file rows');
  assert.ok(result.html.includes('dir-load-more'), 'Directory preview should render load-more warnings');
  assert.ok(result.html.includes('dir-name-denied'), 'Directory preview should render denied entries');

  console.log('✓ directory preview renders folder, file, warning, and denied states');
}

export default async function runTests() {
  try {
    await testDirectoryBodyRendering();
    console.log('\n✅ File preview directory runtime tests passed!');
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
