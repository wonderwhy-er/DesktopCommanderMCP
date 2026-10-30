/**
 * The coverage build's source maps for copied scripts (map-copied-scripts.js):
 * a .js file the build copies into dist/ as it is gets an inline source map
 * pointing every line and column back at its source, so coverage counts the
 * source. It works in a made-up checkout in a temporary folder.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { identityMappings, mapCopiedScripts, vlq } from './map-copied-scripts.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

/** The source map inlined at the end of a file */
function inlineMap(text) {
  const match = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)\n$/.exec(text);
  return match && JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

export default async function run() {
  // Source-map VLQ: sign in the lowest bit, 5 bits a digit, continuation in the 6th
  assert.deepStrictEqual([0, 1, -1, 15, 16, -16].map(vlq), ['A', 'C', 'D', 'e', 'gB', 'hB']);
  // Line 1: columns 0 and 1 to themselves; line 2: back to column 0, one source line down
  assert.strictEqual(identityMappings('ab\nc'), 'AAAA,CAAC;AACD');
  assert.strictEqual(identityMappings(''), 'AAAA', 'an empty file still maps its one line');
  console.log('✓ identity mappings: every column of every line to itself');

  const root = createTempDir('dc-map-copied-scripts-');
  try {
    write(root, 'src/remote-device/scripts/start.js', 'console.log(1);\n');
    write(root, 'dist/remote-device/scripts/start.js', 'console.log(1);\n');
    write(root, 'src/only-in-src.js', 'x\n');
    write(root, 'setup-claude-server.js', 'setup();\n');
    write(root, 'dist/setup-claude-server.js', 'setup();\n');
    const mapped = '//# sourceMappingURL=index.js.map\n';
    write(root, 'src/already.js', 'y\n');
    write(root, 'dist/already.js', `y\n${mapped}`);

    const done = mapCopiedScripts({ root, log: () => {} });
    assert.deepStrictEqual(done.sort(), ['dist/remote-device/scripts/start.js', 'dist/setup-claude-server.js'], 'the copies without a map, and only those');

    const start = inlineMap(fs.readFileSync(path.join(root, 'dist/remote-device/scripts/start.js'), 'utf8'));
    assert.deepStrictEqual(start.sources, ['../../../src/remote-device/scripts/start.js'], 'the map points at the source, from the copy\'s folder');
    assert.strictEqual(start.mappings, identityMappings('console.log(1);\n'));
    assert.deepStrictEqual(inlineMap(fs.readFileSync(path.join(root, 'dist/setup-claude-server.js'), 'utf8')).sources, ['../setup-claude-server.js'],
      'an install script at the root maps to itself');
    assert.strictEqual(fs.readFileSync(path.join(root, 'dist/already.js'), 'utf8'), `y\n${mapped}`, 'a copy that has a map is left as it is');
    assert.ok(!fs.existsSync(path.join(root, 'dist/only-in-src.js')), 'a source without a copy makes nothing');
    assert.deepStrictEqual(mapCopiedScripts({ root, log: () => {} }), [], 'run again, it maps nothing twice');
    console.log('✓ each copy without a map gets one pointing at its source; the rest are left');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
