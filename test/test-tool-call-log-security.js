import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ensureLogFilePermissions, sanitizeArgsForLog } from '../dist/utils/trackTools.js';

const sanitized = sanitizeArgsForLog({
  command: 'rm -rf /',
  path: '/tmp/safe.txt',
  nested: { apiKey: 'sk-secret', offset: 3 },
  env: { TOKEN: 'also-secret' }
});
const serialized = JSON.stringify(sanitized);

assert.ok(serialized.includes('command'));
assert.ok(serialized.includes('/tmp/safe.txt'));
assert.ok(!serialized.includes('rm -rf /'));
assert.ok(!serialized.includes('sk-secret'));
assert.ok(!serialized.includes('also-secret'));

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-log-security-'));
const logFile = path.join(tmpDir, 'tool.log');
try {
  await ensureLogFilePermissions(logFile);
  const stats = await fs.stat(logFile);
  assert.ok(stats.isFile());
  if (process.platform !== 'win32') {
    assert.strictEqual(stats.mode & 0o777, 0o600);
  }
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log('PASS: tool-call logs redact sensitive values and use private permissions');
