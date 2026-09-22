import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
// The worker's first import of the server module measured 25s over /mnt/c.
const TIMEOUT_MS = 60_000;
const TRUNCATED = '{"defaultShell":';
const WITH_POLICY = '{"blockedCommands":["rm","sudo"],"allowedDirectories":["/safe/project"],"usageStats":{';
const FAIL_CLOSED_NOTICE = 'Security settings could not be recovered';

const eperm = async () => {
  throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
};

const CASES = {
  // control: only the preserve step is broken, so a later failure cannot carry it.
  'preserve-failure': {
    corrupt: TRUNCATED,
    async worker({ configManager, commandManager, CONFIG_FILE, logs }) {
      const fsp = (await import('node:fs/promises')).default;
      const originalCopyFile = fsp.copyFile;
      fsp.copyFile = eperm;
      try {
        const config = await configManager.getConfig();
        assert.deepEqual(config.blockedCommands, ['*'],
          'recovery that cannot preserve the damaged file must not fall back to the default blocklist');
        assert.deepEqual(config.allowedDirectories, [path.dirname(CONFIG_FILE)],
          'recovery that cannot preserve the damaged file must not fall back to unrestricted file access');
        assert.equal(await commandManager.validateCommand('echo hello'), false);
      } finally {
        fsp.copyFile = originalCopyFile;
      }
      assert.ok(logs.some((line) => line.includes('all commands are blocked') && line.includes(CONFIG_FILE)),
        'the operator is told what was restricted and which file to repair');
    }
  },

  // Losing the file entirely starts the next run from a fresh default.
  'replacement-write-failure': {
    corrupt: TRUNCATED,
    async worker({ configManager, CONFIG_FILE }) {
      const originalWrite = configManager.writeConfigAtomically;
      configManager.writeConfigAtomically = async () => {
        throw new Error('synthetic replacement write failure');
      };
      try {
        await configManager.getConfig();
      } finally {
        configManager.writeConfigAtomically = originalWrite;
      }
      assert.ok(existsSync(CONFIG_FILE),
        'the damaged config survives a replacement that could not be written');
      assert.equal(readFileSync(CONFIG_FILE, 'utf8'), TRUNCATED,
        'the damaged config is left byte for byte');
    }
  },

  'repeated-preserve': {
    corrupt: TRUNCATED,
    runs: 2,
    async worker({ configManager }) {
      configManager.writeConfigAtomically = async () => {
        throw new Error('synthetic replacement write failure');
      };
      await configManager.getConfig();
    },
    verify(dir) {
      const backups = readdirSync(dir).filter((name) => name.startsWith('config.json.corrupt.'));
      assert.equal(backups.length, 1,
        'a start that meets the same damaged config again does not add another copy of it');
      assert.equal(readFileSync(path.join(dir, backups[0]), 'utf8'), TRUNCATED);
    }
  },

  'bounded-backups': {
    corrupt: TRUNCATED,
    prepare(dir) {
      for (let i = 0; i < 6; i++) {
        const file = path.join(dir, `config.json.corrupt.16000000000${i}.999`);
        writeFileSync(file, `older damaged config ${i}`);
        const when = new Date(Date.now() - (10 - i) * 60_000);
        utimesSync(file, when, when);
      }
    },
    async worker({ configManager }) {
      await configManager.getConfig();
    },
    verify(dir) {
      const backups = readdirSync(dir).filter((name) => name.startsWith('config.json.corrupt.'));
      assert.ok(backups.length <= 5, `${backups.length} copies of the damaged config kept`);
      assert.ok(backups.some((name) => readFileSync(path.join(dir, name), 'utf8') === TRUNCATED),
        'the copy just made is kept');
      assert.ok(!backups.includes('config.json.corrupt.160000000000.999'),
        'the oldest copy is the one dropped');
    }
  },

  'salvaged-policy-survives-init-failure': {
    corrupt: WITH_POLICY,
    async worker({ configManager, logs }) {
      // Fail one step after recovery, not the recovery itself, and only once:
      // init() calls this again while handling the failure.
      const originalWatcher = configManager.startConfigWatcher;
      let calls = 0;
      configManager.startConfigWatcher = function (...args) {
        if (++calls === 1) throw new Error('synthetic watcher failure');
        return originalWatcher.apply(this, args);
      };
      const config = await configManager.getConfig();
      assert.deepEqual(config.blockedCommands, ['rm', 'sudo'],
        'a salvaged blocklist survives a later startup failure');
      assert.deepEqual(config.allowedDirectories, ['/safe/project'],
        'a salvaged allowlist survives a later startup failure');
      assert.ok(!logs.some((line) => line.includes(FAIL_CLOSED_NOTICE)),
        'nothing claims the policy was lost when it was recovered');
    }
  },

  'denied-command-explains': {
    corrupt: TRUNCATED,
    async worker({ CONFIG_FILE }) {
      const { startProcess } = await import('../dist/tools/improved-process-tools.js');
      const result = await startProcess({ command: 'echo hello', timeout_ms: 1_000 });
      const text = result.content.map((part) => part.text).join('\n');
      assert.equal(result.isError, true);
      assert.match(text, /Command not allowed/);
      assert.ok(text.includes('all commands are blocked'),
        'the refusal says the blocklist came from recovery, not from the user');
      assert.ok(text.includes(CONFIG_FILE),
        'the refusal names the file that restores access');
    }
  },

  // Worst case for the copies: five, each the size of the damaged file, so none
  // can be ruled out unread.
  'bounded-reads': {
    corrupt: TRUNCATED,
    prepare(dir) {
      for (let i = 0; i < 5; i++) {
        writeFileSync(path.join(dir, `config.json.corrupt.16000000000${i}.999`),
          TRUNCATED.slice(0, -1) + String(i));
      }
    },
    async worker({ configManager, CONFIG_FILE }) {
      const fsp = (await import('node:fs/promises')).default;
      const original = { readFile: fsp.readFile, readdir: fsp.readdir };
      const counts = { readFile: 0, readdir: 0 };
      const configDir = path.dirname(CONFIG_FILE);
      fsp.readFile = (file, ...rest) => {
        if (path.dirname(String(file)) === configDir) counts.readFile++;
        return original.readFile(file, ...rest);
      };
      fsp.readdir = (dir, ...rest) => {
        if (String(dir) === configDir) counts.readdir++;
        return original.readdir(dir, ...rest);
      };
      try {
        await configManager.getConfig();
      } finally {
        Object.assign(fsp, original);
      }
      assert.ok(counts.readFile <= 13,
        `one recovery reads ${counts.readFile} files in the config directory`);
      assert.ok(counts.readdir <= 1,
        `one recovery lists the config directory ${counts.readdir} times`);
    }
  },

  // The next start finds a valid config and nothing damaged.
  'explains-after-restart': {
    corrupt: TRUNCATED,
    runs: 2,
    async worker({ configManager, CONFIG_FILE, runIndex }) {
      if (runIndex === 0) {
        await configManager.getConfig();
        return;
      }

      const { startProcess } = await import('../dist/tools/improved-process-tools.js');
      const config = await configManager.getConfig();
      assert.deepEqual(config.blockedCommands, ['*'], 'the fallback is what this start reads');
      const refusal = (await startProcess({ command: 'echo hello', timeout_ms: 1_000 }))
        .content.map((part) => part.text).join('\n');
      assert.ok(refusal.includes('all commands are blocked'),
        'a start after recovery still explains the policy it refuses by');
      assert.ok(refusal.includes(CONFIG_FILE), 'and still names the file that restores access');

      await configManager.setValue('blockedCommands', ['rm']);
      await configManager.setValue('allowedDirectories', ['/safe/project']);
      assert.equal(configManager.failClosedExplanation(), null,
        'settings the user has restored are no longer explained as a fallback');
    }
  },

  'path-refusal-explains': {
    corrupt: TRUNCATED,
    async worker({ configManager, CONFIG_FILE }) {
      await configManager.getConfig();
      const { validatePath } = await import('../dist/tools/filesystem.js');
      const refusal = await validatePath(path.join(os.tmpdir(), 'somewhere-else', 'notes.txt'))
        .then(() => null, (error) => error.message);
      assert.ok(refusal, 'a path outside the recovered allowlist is refused');
      assert.ok(refusal.includes('file access is limited to'),
        'the refusal says the allowlist came from recovery, not from the user');
      assert.ok(refusal.includes(CONFIG_FILE), 'and names the file that restores access');
    }
  },

  // "Preserved" is about the file, not about which start copied it.
  'preserved-copy-reported': {
    corrupt: TRUNCATED,
    runs: 2,
    async worker({ configManager, CONFIG_FILE, logs, runIndex }) {
      const events = [];
      configManager.emitCorruptConfigTelemetry = async (telemetry) => { events.push(telemetry); };
      // The second start meets the same damage again, its copy already kept.
      if (runIndex === 1) writeFileSync(CONFIG_FILE, TRUNCATED);
      await configManager.getConfig();
      if (runIndex === 0) return;

      assert.equal(events.length, 1);
      assert.equal(events[0].backup_created, true,
        'the damaged config is preserved, whether or not this start is what copied it');
      assert.ok(logs.some((line) => line.includes('preserved the corrupt file')),
        'and stderr says so');
    }
  },

  // A damaged fallback reads as an ordinary top-level policy.
  'explains-after-second-damage': {
    corrupt: TRUNCATED,
    runs: 2,
    async worker({ configManager, CONFIG_FILE, runIndex }) {
      if (runIndex === 0) {
        await configManager.getConfig();
        return;
      }

      const configDir = path.dirname(CONFIG_FILE);
      const damagedAgain = '{"blockedCommands":["*"],"allowedDirectories":'
        + `${JSON.stringify([configDir])},"recoveryFailClosedFields":["blockedCommands","allowedDirectories"],"usageStats":{`;
      writeFileSync(CONFIG_FILE, damagedAgain);

      const config = await configManager.getConfig();
      assert.deepEqual(config.blockedCommands, ['*'], 'the fallback values are salvaged as they stand');
      assert.ok(configManager.failClosedExplanation(),
        'damage to a recovered config does not turn its fallback into a user setting');

      // Same again while the process is running: the mark is in memory now.
      writeFileSync(CONFIG_FILE, damagedAgain);
      await configManager.setValue('__afterSecondDamage', 1);
      assert.ok(configManager.failClosedExplanation(),
        'runtime recovery keeps the mark too');
      assert.deepEqual(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).recoveryFailClosedFields,
        ['blockedCommands', 'allowedDirectories'],
        'and writes it back to disk');
    }
  },

  // Truncation eats a file from the end, so a cut can take the mark and leave
  // the policy.
  'mark-survives-truncation-after-policy': {
    corrupt: TRUNCATED,
    runs: 2,
    async worker({ configManager, CONFIG_FILE, runIndex }) {
      if (runIndex === 0) {
        await configManager.getConfig();
        return;
      }

      // The cut lands after the last policy field, so both survive it.
      const recovered = readFileSync(CONFIG_FILE, 'utf8');
      const allowlistAt = recovered.indexOf('"allowedDirectories"');
      assert.ok(allowlistAt > 0, 'the recovered config carries the allowlist');
      const allowlistEnd = recovered.indexOf(']', allowlistAt);
      writeFileSync(CONFIG_FILE, `${recovered.slice(0, allowlistEnd + 1)},\n  "usageStats": {`);

      const config = await configManager.getConfig();
      assert.deepEqual(config.blockedCommands, ['*'], 'the policy itself survives the cut');
      assert.ok(configManager.failClosedExplanation(),
        'a cut that keeps the policy keeps what says where the policy came from');
    }
  },

  'marker-cleared-on-manual-repair': {
    corrupt: TRUNCATED,
    async worker({ configManager, CONFIG_FILE }) {
      await configManager.getConfig();
      assert.ok(configManager.failClosedExplanation(), 'the fallback is in force to begin with');

      // control: a startup write would otherwise carry the cleanup for free.
      let settled = '';
      for (let stable = 0; stable < 6; stable++) {
        const seen = readFileSync(CONFIG_FILE, 'utf8');
        if (seen !== settled) { settled = seen; stable = -1; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      writeFileSync(CONFIG_FILE, JSON.stringify({
        blockedCommands: ['rm'],
        allowedDirectories: ['/safe/project'],
        recoveryFailClosedFields: ['blockedCommands', 'allowedDirectories']
      }, null, 2));

      const deadline = Date.now() + 4_000;
      let onDisk;
      while (Date.now() < deadline) {
        onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
        if (!('recoveryFailClosedFields' in onDisk)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(!('recoveryFailClosedFields' in onDisk),
        'a config the user has repaired does not keep recovery\'s mark');
      assert.equal(configManager.failClosedExplanation(), null,
        'and nothing explains refusals by a policy that is now the user\'s own');
    }
  },

  // Two files that decode to the same replacement characters are two files.
  'distinct-bytes-same-text': {
    corrupt: TRUNCATED,
    runs: 2,
    async worker({ configManager, CONFIG_FILE, runIndex }) {
      if (runIndex === 1) {
        writeFileSync(CONFIG_FILE, Buffer.concat([Buffer.from('{"a":'), Buffer.from([0xfe])]));
      }
      configManager.writeConfigAtomically = async () => {
        throw new Error('synthetic replacement write failure');
      };
      await configManager.getConfig();
    },
    prepare(dir) {
      writeFileSync(path.join(dir, 'config.json'),
        Buffer.concat([Buffer.from('{"a":'), Buffer.from([0xff])]));
    },
    verify(dir) {
      const backups = readdirSync(dir).filter((name) => name.startsWith('config.json.corrupt.'));
      assert.equal(backups.length, 2,
        'two damaged files that decode alike are still two damaged files');
    }
  }
};

async function worker(caseName, runIndex) {
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.map((arg) => String(arg)).join(' ')); };
  try {
    const [{ configManager }, { commandManager }, { CONFIG_FILE }] = await Promise.all([
      import('../dist/config-manager.js'),
      import('../dist/command-manager.js'),
      import('../dist/config.js')
    ]);
    await CASES[caseName].worker({ configManager, commandManager, CONFIG_FILE, logs, runIndex });
  } finally {
    console.error = originalError;
  }
  process.send?.({ type: 'done' });
}

function runWorker(caseName, home, runIndex) {
  const child = fork(TEST_FILE, [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DC_CONFIG_RECOVERY_FAILURE_CASE: caseName,
      DC_RUN_INDEX: String(runIndex),
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1'
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout waiting for the ${caseName} worker`));
    }, TIMEOUT_MS);
    child.on('message', (message) => {
      if (message.type !== 'done') return;
      clearTimeout(timer);
      const exited = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      exited.then(resolve);
    });
    child.on('exit', (code) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`${caseName} worker exited ${code}`));
      }
    });
  });
}

async function runCase(caseName) {
  const testCase = CASES[caseName];
  const home = mkdtempSync(path.join(os.tmpdir(), `dc-config-recovery-failure-${caseName}-`));
  const dir = path.join(home, '.claude-server-commander');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), testCase.corrupt);
  testCase.prepare?.(dir);

  try {
    for (let run = 0; run < (testCase.runs ?? 1); run++) {
      await runWorker(caseName, home, run);
    }
    testCase.verify?.(dir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function parent() {
  for (const caseName of Object.keys(CASES)) {
    await runCase(caseName);
  }
  console.log('✓ recovery that cannot finish stays fail-closed, keeps one copy of the damaged config, and says so where it is read');
}

const workerCase = process.env.DC_CONFIG_RECOVERY_FAILURE_CASE;
if (workerCase) await worker(workerCase, Number(process.env.DC_RUN_INDEX ?? 0)); else await parent();
