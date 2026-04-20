import assert from 'assert';
import { pathToFileURL } from 'url';

import { createWidgetStateStorage } from '../dist/ui/shared/widget-state.js';

function createMockSessionStorage() {
  const data = new Map();
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

function createMockWindow(pathname, sessionStorage, name = '') {
  return {
    location: { pathname },
    sessionStorage,
    name,
  };
}

async function testWidgetStateUsesPerFrameKeys() {
  console.log('\n--- Test: widget state keeps same-origin iframes isolated ---');

  const originalWindow = globalThis.window;
  const sessionStorage = createMockSessionStorage();

  try {
    const firstWindow = createMockWindow('/ui/file-preview/index.html', sessionStorage);
    globalThis.window = firstWindow;
    const firstStorage = createWidgetStateStorage((value) => typeof value === 'string');
    firstStorage.write('first payload');

    assert.ok(firstWindow.name.includes('__dc_widget_id__:'), 'The first frame should persist its widget id in window.name');
    assert.strictEqual(firstStorage.read(), 'first payload', 'The first frame should read back its own cached payload');

    const secondWindow = createMockWindow('/ui/file-preview/index.html', sessionStorage);
    globalThis.window = secondWindow;
    const secondStorage = createWidgetStateStorage((value) => typeof value === 'string');
    secondStorage.write('second payload');

    assert.ok(secondWindow.name.includes('__dc_widget_id__:'), 'The second frame should persist its widget id in window.name');
    assert.notStrictEqual(secondWindow.name, firstWindow.name, 'Visible frames should get distinct widget ids');
    assert.strictEqual(secondStorage.read(), 'second payload', 'The second frame should read back its own cached payload');
    assert.strictEqual(sessionStorage.data.size, 2, 'Two same-origin frames should write to separate cache keys');

    const refreshedFirstWindow = createMockWindow('/ui/file-preview/index.html', sessionStorage, firstWindow.name);
    globalThis.window = refreshedFirstWindow;
    const refreshedFirstStorage = createWidgetStateStorage((value) => typeof value === 'string');
    assert.strictEqual(refreshedFirstStorage.read(), 'first payload', 'Reloading the first frame should preserve its cache slot');

    const refreshedSecondWindow = createMockWindow('/ui/file-preview/index.html', sessionStorage, secondWindow.name);
    globalThis.window = refreshedSecondWindow;
    const refreshedSecondStorage = createWidgetStateStorage((value) => typeof value === 'string');
    assert.strictEqual(refreshedSecondStorage.read(), 'second payload', 'Reloading the second frame should preserve its own cache slot');
  } finally {
    globalThis.window = originalWindow;
  }

  console.log('✓ widget state keeps same-origin iframes isolated across refresh');
}

export default async function runTests() {
  try {
    await testWidgetStateUsesPerFrameKeys();
    console.log('\n✅ Widget state runtime tests passed!');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTests().then((success) => {
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
