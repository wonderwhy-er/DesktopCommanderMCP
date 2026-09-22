/**
 * #692 reports its fix as "real remote tool execution worked again", so this
 * starts the real local MCP child and makes it work, rather than refuse tidily.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 90_000;
const MARKER = 'dc692-remote-ok';
// The policy at the root allows ordinary work: otherwise a green run proves nothing.
const CORRUPT = '{"blockedCommands":["rm","sudo"],"allowedDirectories":["__HOME__"],"telemetryEnabled":false,"usageStats":{';

async function worker() {
  const { DesktopCommanderIntegration } = await import('../dist/remote-device/desktop-commander-integration.js');
  const { CONFIG_FILE } = await import('../dist/config.js');
  const home = path.dirname(path.dirname(CONFIG_FILE));

  const integration = new DesktopCommanderIntegration();
  try {
    // Where #692 dies: "MCP error -32603: Unexpected end of JSON input".
    await integration.initialize();
    assert.equal(integration.ready, true, 'the local MCP child is reachable after a damaged config');

    const started = await integration.callClientTool('start_process', {
      command: `echo ${MARKER}`,
      timeout_ms: 8_000
    });
    const startedText = started.content.map((part) => part.text).join('\n');
    assert.ok(!started.isError, `start_process failed: ${startedText}`);
    assert.ok(startedText.includes(MARKER),
      `a real command runs and returns its output after recovery: ${startedText}`);

    const notes = path.join(home, 'notes.txt');
    writeFileSync(notes, `${MARKER} file body`);
    const read = await integration.callClientTool('read_file', { path: notes });
    const readText = read.content.map((part) => part.text).join('\n');
    assert.ok(!read.isError, `read_file failed: ${readText}`);
    assert.ok(readText.includes(MARKER), 'a file inside the salvaged allowlist is readable');
  } finally {
    await integration.shutdown().catch(() => {});
  }

  process.send?.({ type: 'done' });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-remote-corrupt-'));
  const dir = path.join(home, '.claude-server-commander');
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, CORRUPT.replace('__HOME__', home.replace(/\\/g, '\\\\')));

  const child = fork(TEST_FILE, [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DC_REMOTE_CORRUPT_WORKER: '1',
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1'
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('timeout waiting for the remote start worker'));
      }, TIMEOUT_MS);
      child.on('message', (message) => {
        if (message.type !== 'done') return;
        clearTimeout(timer);
        resolve();
      });
      child.on('exit', (code) => {
        if (code && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`remote start worker exited ${code}`));
        }
      });
    });

    const recovered = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(recovered.blockedCommands, ['rm', 'sudo'],
      'the salvaged blocklist is what the running device enforces');
    assert.deepEqual(recovered.allowedDirectories, [home],
      'and so is the salvaged allowlist');
    assert.equal(recovered.telemetryEnabled, false, 'the opt-out survives the start');
    console.log('✓ remote device starts on a damaged config and runs real tools with the salvaged policy');
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_REMOTE_CORRUPT_WORKER === '1') await worker(); else await parent();
