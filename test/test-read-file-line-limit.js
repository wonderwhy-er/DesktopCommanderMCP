import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { configManager } from '../dist/config-manager.js';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, 'test_read_file_line_limit');
const TEST_FILE = path.join(TEST_DIR, 'twenty-lines.txt');

function extractReadCount(result) {
  const text = result?.content?.[0]?.text ?? '';
  const match = text.match(/\[Reading (\d+) lines/);
  return match ? Number(match[1]) : null;
}

let originalConfig;
let exitCode = 0;

try {
  originalConfig = await configManager.getConfig();
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(
    TEST_FILE,
    Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n'),
    'utf8'
  );

  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  await configManager.setValue('fileReadLineLimit', 7);

  const omittedLength = await handleReadFile({ path: TEST_FILE });
  assert.strictEqual(
    extractReadCount(omittedLength),
    7,
    'read_file should use fileReadLineLimit when length is omitted'
  );
  console.log('✓ omitted length uses configured fileReadLineLimit');

  const explicitLength = await handleReadFile({ path: TEST_FILE, length: 4 });
  assert.strictEqual(
    extractReadCount(explicitLength),
    4,
    'explicit read_file length should override fileReadLineLimit'
  );
  console.log('✓ explicit length overrides configured fileReadLineLimit');
} catch (error) {
  console.error(`✗ ${error.message}`);
  exitCode = 1;
} finally {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  if (originalConfig) {
    await configManager.updateConfig(originalConfig);
  }
}

process.exit(exitCode);
