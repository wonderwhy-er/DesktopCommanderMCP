/**
 * Part of the coverage build (`npm run build:coverage`). The build copies some
 * plain .js files into dist/ as they are, with no source map, so c8 would count the
 * dist/ copy instead of the source: the files under src/ that aren't TypeScript
 * (src/remote-device/scripts/) and the install scripts at the root
 * (setup-claude-server.js, uninstall-claude-server.js, track-installation.js). This
 * gives each copy an inline source map that points every line and column back at
 * its source. Copies that already have a source map are left as they are.
 *
 *   node test/map-copied-scripts.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTALL_SCRIPTS } from './check-coverage-report.js';
import { ROOT } from './helpers/node-test-runner.js';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One source-map VLQ number */
export function vlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

/** Mappings for a file that is its own source: every column of every line to itself */
export function identityMappings(text) {
  let previousColumn = 0;
  return text.split('\n').map((line, i) => {
    const columns = Math.max(line.length, 1);
    // Each line starts at generated column 0, one source line down, back to source column 0
    const segments = [vlq(0) + vlq(0) + vlq(i === 0 ? 0 : 1) + vlq(-previousColumn)];
    for (let column = 1; column < columns; column++) segments.push(vlq(1) + vlq(0) + vlq(0) + vlq(1));
    previousColumn = columns - 1;
    return segments.join(',');
  }).join(';');
}

/** Gives each copy in root's dist/ without a source map one; returns the copies it mapped, from root */
export function mapCopiedScripts({ root = ROOT, log = console.log } = {}) {
  // [source, its copy in dist/], both from the checkout's root
  const copied = INSTALL_SCRIPTS.map((script) => [script, `dist/${script}`]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.(js|mjs|cjs)$/.test(entry.name)) copied.push([file, `dist/${file.slice('src/'.length)}`]);
    }
  };
  walk('src');

  const mapped = [];
  for (const [source, copyPath] of copied) {
    const copy = path.join(root, copyPath);
    if (!fs.existsSync(copy)) continue;
    const text = fs.readFileSync(copy, 'utf8');
    if (text.includes('sourceMappingURL=')) continue;
    const map = {
      version: 3,
      file: path.basename(copy),
      sources: [path.relative(path.dirname(copy), path.join(root, source)).split(path.sep).join('/')],
      names: [],
      mappings: identityMappings(text),
    };
    const comment = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    fs.writeFileSync(copy, `${text}${text.endsWith('\n') ? '' : '\n'}${comment}\n`);
    log(`source map added: ${copyPath} -> ${source}`);
    mapped.push(copyPath);
  }
  return mapped;
}

// Real paths on both sides: started through a symlink or junction, it still runs
if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  mapCopiedScripts();
}
