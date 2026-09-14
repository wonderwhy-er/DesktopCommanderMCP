import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

async function runTests() {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-log-test-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousUmask = process.umask(0);

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const logDir = path.join(tempHome, '.claude-server-commander');
    const logPath = path.join(logDir, 'claude_tool_call.log');
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logPath, 'existing log\n', { mode: 0o644 });

    const { sanitizeArgsForLog, trackToolCall } = await import('../dist/utils/trackTools.js');

    if (process.platform !== 'win32') {
      const existingMode = (await fs.stat(logPath)).mode & 0o777;
      assert.equal(existingMode, 0o600, 'existing tool-call logs must be tightened to owner-only access');
    }

    const originalArgs = {
      command: 'curl -H "Authorization: Bearer command-secret" https://example.test',
      content: 'file-content-secret',
      path: '/tmp/example.txt',
      timeout_ms: 30000,
      nested: {
        apiKey: 'api-key-secret',
        password: 'password-secret',
        headers: { Authorization: 'Bearer authorization-secret' },
        signing_key: 'signing-key-secret',
        fileContent: 'nested-content-secret',
        safe: 'visible',
      },
      env: { SERVICE_TOKEN: 'environment-secret' },
      items: [{ refresh_token: 'refresh-token-secret', count: 2 }],
    };

    const sanitized = sanitizeArgsForLog(originalArgs);
    const serialized = JSON.stringify(sanitized);

    for (const secret of [
      'command-secret',
      'file-content-secret',
      'api-key-secret',
      'password-secret',
      'authorization-secret',
      'signing-key-secret',
      'nested-content-secret',
      'environment-secret',
      'refresh-token-secret',
    ]) {
      assert(!serialized.includes(secret), `sanitized arguments must not contain ${secret}`);
    }

    assert.equal(sanitized.path, '/tmp/example.txt');
    assert.equal(sanitized.timeout_ms, 30000);
    assert.equal(sanitized.nested.safe, 'visible');
    assert.equal(sanitized.items[0].count, 2);
    assert.match(sanitized.command, /^\[REDACTED:string:\d+chars\]$/);
    assert.match(sanitized.nested.apiKey, /^\[REDACTED:string:\d+chars\]$/);
    assert.match(sanitized.nested.signing_key, /^\[REDACTED:string:\d+chars\]$/);
    assert.match(sanitized.nested.fileContent, /^\[REDACTED:string:\d+chars\]$/);
    assert.match(sanitized.env, /^\[REDACTED:object:\d+chars\]$/);
    assert.equal(originalArgs.content, 'file-content-secret', 'sanitization must not mutate caller arguments');

    await fs.rm(logPath);
    await trackToolCall('write_file', originalArgs);

    const log = await fs.readFile(logPath, 'utf8');
    assert(log.includes('write_file'));
    assert(log.includes('/tmp/example.txt'));
    assert(log.includes('"timeout_ms":30000'));
    assert(log.includes('[REDACTED:string:'));

    for (const secret of [
      'command-secret',
      'file-content-secret',
      'api-key-secret',
      'password-secret',
      'authorization-secret',
      'signing-key-secret',
      'nested-content-secret',
      'environment-secret',
      'refresh-token-secret',
    ]) {
      assert(!log.includes(secret), `tool-call log must not contain ${secret}`);
    }

    if (process.platform !== 'win32') {
      const mode = (await fs.stat(logPath)).mode & 0o777;
      assert.equal(mode, 0o600, 'new tool-call logs must be created with owner-only access');
    }

    console.log('Tool-call log security tests passed');
  } finally {
    process.umask(previousUmask);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
