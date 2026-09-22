import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
// The worker's first import of the server module measured 25s over /mnt/c.
const TIMEOUT_MS = 60_000;

async function expectFailClosed({ configManager, commandManager, CONFIG_FILE }, why) {
  const config = await configManager.getConfig();
  assert.deepEqual(config.blockedCommands, ['*'], why);
  assert.deepEqual(config.allowedDirectories, [path.dirname(CONFIG_FILE)], why);
  assert.equal(await commandManager.validateCommand('echo hello'), false, why);
}

async function expectSalvaged({ configManager }, blockedCommands, allowedDirectories, why) {
  const config = await configManager.getConfig();
  assert.deepEqual(config.blockedCommands, blockedCommands, why);
  assert.deepEqual(config.allowedDirectories, allowedDirectories, why);
}

const CASES = {
  // "/" is unrestricted access, not a narrower policy.
  'nested-decoy': {
    corrupt: '{"clientId":"11111111-1111-4111-8111-111111111111","usageStats":{"blockedCommands":["rm"],"allowedDirectories":["/"]},"defaultShell":',
    async check(context) {
      await expectFailClosed(context, 'a nested policy is not this install\'s policy');
      assert.ok(
        context.logs.some((line) => line.includes('all commands are blocked')
          && line.includes(path.dirname(context.CONFIG_FILE))),
        'the operator is told which restrictions recovery applied'
      );
    }
  },
  'unbalanced-close': {
    corrupt: '{"a":1}}{"junk":{"blockedCommands":["rm"],"allowedDirectories":["/"]},"b":',
    check: (context) => expectFailClosed(context, 'depth that ran past the root object salvages nothing')
  },
  'after-root-close': {
    corrupt: '{"a":1}{"blockedCommands":["rm"],"allowedDirectories":["/"],"b":',
    check: (context) => expectFailClosed(context, 'fields after the root object are not root fields')
  },
  'non-object-root': {
    corrupt: 'xx{"blockedCommands":["rm"],"allowedDirectories":["/"],"b":',
    check: (context) => expectFailClosed(context, 'nothing is top-level when the root is not an object')
  },
  // control: the scan must carry on past it to the real field.
  'field-name-as-value': {
    corrupt: '{"note":"blockedCommands","blockedCommands":["rm","sudo"],"allowedDirectories":["/safe/project"],"u":{',
    check: (context) => expectSalvaged(context, ['rm', 'sudo'], ['/safe/project'],
      'a value that repeats a field name does not stop the scan')
  },
  // control: the fix must not over-restrict; braces sit inside a string value.
  'top-level': {
    corrupt: '{"note":"a { b [ c","blockedCommands":["rm","sudo"],"allowedDirectories":["/safe/project"],"usageStats":{',
    check: (context) => expectSalvaged(context, ['rm', 'sudo'], ['/safe/project'],
      'a complete top-level policy is still salvaged')
  }
};

async function worker(caseName) {
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.map((arg) => String(arg)).join(' ')); };
  try {
    const [{ configManager }, { commandManager }, { CONFIG_FILE }] = await Promise.all([
      import('../dist/config-manager.js'),
      import('../dist/command-manager.js'),
      import('../dist/config.js')
    ]);
    await CASES[caseName].check({ configManager, commandManager, CONFIG_FILE, logs });
  } finally {
    console.error = originalError;
  }
  process.send?.({ type: 'done' });
}

async function runCase(caseName) {
  const home = mkdtempSync(path.join(os.tmpdir(), `dc-config-decoy-${caseName}-`));
  const dir = path.join(home, '.claude-server-commander');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), CASES[caseName].corrupt);

  const child = fork(TEST_FILE, [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DC_CONFIG_DECOY_CASE: caseName,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1'
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`timeout waiting for the ${caseName} worker`));
      }, TIMEOUT_MS);
      child.on('message', (message) => {
        if (message.type !== 'done') return;
        clearTimeout(timer);
        resolve();
      });
      child.on('exit', (code) => {
        if (code && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`${caseName} worker exited ${code}`));
        }
      });
    });
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

async function parent() {
  for (const caseName of Object.keys(CASES)) {
    await runCase(caseName);
  }
  console.log('✓ corrupt config salvages only root-level policy fields and stays fail-closed otherwise');
}

const workerCase = process.env.DC_CONFIG_DECOY_CASE;
if (workerCase) await worker(workerCase); else await parent();
