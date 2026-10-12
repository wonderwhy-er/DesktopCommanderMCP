/**
 * A damaged config.json (it can't be parsed, even after #773's wait) is
 * replaced, keeping everything still readable in it: the longest beginning of
 * the file that is a JSON object once closed, so every complete top-level
 * setting before the damage, whatever its key. Every other setting gets its
 * default; while running, the settings last read come between the two. The
 * damaged file is kept as one config.json.corrupt.<time>.<pid> copy, the log
 * says so, and the welcome page stays off (an existing install). Nothing is
 * "closed": no "block every command", no "config folder only". A config.json
 * that can't be read at all isn't damaged: it is left as it is, and the
 * session uses the defaults, with a warning.
 *
 * Each case loads the config manager in a child process of its own, in a
 * temporary home.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createTestEnv } from './helpers/test-env.js';
import { runConfigManagerChild } from './helpers/config-child.js';
import { runIfMain } from './helpers/run-if-main.js';

const CLIENT_ID = '0b7f9a52-5a3e-4c6e-9d59-3f1a2b4c5d6e';

/** A temporary home whose config.json holds `content` (bytes or text) */
function homeWithConfig(content) {
  const testEnv = createTestEnv();
  const configDir = path.join(testEnv.home, '.claude-server-commander');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, content);
  return { ...testEnv, configDir, configPath };
}

const corruptCopiesIn = (configDir) => fs.readdirSync(configDir).filter((name) => name.startsWith('config.json.corrupt.'));

/** runConfigManagerChild body: the settings in effect and on disk after startup, and the defaults to compare with */
const settingsAfterStartup = `
  const { CONFIG_FILE } = await import(DIST + '/config.js');
  const { commandManager } = await import(DIST + '/command-manager.js');
  const config = await configManager.getConfig();
  let onDisk = null;
  try { onDisk = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* left as it was */ }
  console.log(JSON.stringify({ config, onDisk, defaults: configManager.getDefaultConfig(),
    firstRun: configManager.isFirstRun(), echoAllowed: await commandManager.validateCommand('echo hello') }));`;

/** `config`'s values of `keys` */
const pick = (config, keys) => Object.fromEntries(keys.map((key) => [key, config?.[key]]));

/** Starts the config manager on `damaged`; checks that in effect and on disk, `keys` hold `expected(defaults)` */
async function checkStartup(damaged, keys, expected) {
  const home = homeWithConfig(damaged);
  try {
    const child = runConfigManagerChild(home.env, { body: settingsAfterStartup });
    assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
    const { config, onDisk, defaults } = child.result;
    const want = expected(defaults);
    assert.deepStrictEqual(pick(config, keys), want, `the settings in effect are ${JSON.stringify(pick(config, keys))}`);
    assert.deepStrictEqual(pick(onDisk, keys), want, `config.json was replaced with ${JSON.stringify(pick(onDisk, keys))}`);
    return child.result;
  } finally {
    home.cleanup();
  }
}

async function run() {
  const failures = [];
  let total = 0;
  const check = async (name, test) => {
    total++;
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`✗ ${name}\n  ${error.message}`);
    }
  };

  // 1. Cut short (a write cut off): everything before the cut is complete
  await check('a truncated file keeps every complete setting before the cut, any key; the cut one gets its default', async () => {
    const before = {
      defaultShell: 'test-shell', fileReadLineLimit: 123, someUnknownKey: 'kept', abTest_x: 'B',
      usageStats: { totalToolCalls: 5 }, clientId: CLIENT_ID, allowedDirectories: ['/work'],
    };
    const damaged = `${JSON.stringify(before, null, 2).slice(0, -2)},\n  "blockedCommands": ["rm", "su`;
    await checkStartup(damaged, [...Object.keys(before), 'blockedCommands'],
      (defaults) => ({ ...before, blockedCommands: defaults.blockedCommands }));
  });

  // 2. A typo in the middle (a hand edit): what comes after it can't be read
  await check('a typo in the middle: the settings before it are kept, the ones after it get their defaults', async () => {
    const damaged = '{"fileReadLineLimit": 123, "defaultShell": "test-shell", "fileWriteLineLimit": 7O, '
      + '"allowedDirectories": ["/work"], "telemetryEnabled": false}';
    await checkStartup(damaged, ['fileReadLineLimit', 'defaultShell', 'fileWriteLineLimit', 'allowedDirectories', 'telemetryEnabled'],
      (defaults) => ({ fileReadLineLimit: 123, defaultShell: 'test-shell', fileWriteLineLimit: defaults.fileWriteLineLimit,
        allowedDirectories: defaults.allowedDirectories, telemetryEnabled: defaults.telemetryEnabled }));
  });

  // 3. Nothing readable: an empty file, or NUL bytes as a crash mid-write leaves them
  for (const [kind, damaged] of [['empty', Buffer.alloc(0)], ['NUL-filled', Buffer.alloc(64)]]) {
    await check(`an ${kind} file gets the defaults: the default blocked commands, every folder, \`echo hello\` runs`, async () => {
      const result = await checkStartup(damaged, ['blockedCommands', 'allowedDirectories', 'fileReadLineLimit'],
        (defaults) => pick(defaults, ['blockedCommands', 'allowedDirectories', 'fileReadLineLimit']));
      assert.strictEqual(result.echoAllowed, true, '`echo hello` was refused');
    });
  }

  // 4. Damaged while running (a write cut short, after a hand edit of its first settings)
  await check('damage while running: the settings last read, with what the damaged file still gives on top', async () => {
    const lastRead = {
      allowedDirectories: ['/work'], blockedCommands: ['rm'], telemetryEnabled: false, fileReadLineLimit: 123,
      defaultShell: 'test-shell', clientId: CLIENT_ID, pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false,
    };
    const damaged = '{\n  "allowedDirectories": ["/edited"],\n  "fileReadLineLimit": 77,\n  "blockedCommands": [';
    const home = homeWithConfig(JSON.stringify(lastRead, null, 2));
    try {
      const child = runConfigManagerChild(home.env, {
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          await configManager.getConfig();
          fsSync.writeFileSync(CONFIG_FILE, ${JSON.stringify(damaged)});
          await configManager.setValue('sawOnboardingPage', true);
          const config = await configManager.getConfig();
          const onDisk = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
          console.log(JSON.stringify({ config, onDisk }));`,
      });
      assert(child.status === 0 && child.result, `the child failed (${child.status}): ${child.stderr}`);
      const keys = ['allowedDirectories', 'fileReadLineLimit', 'blockedCommands', 'telemetryEnabled', 'defaultShell', 'clientId'];
      const expected = { ...pick(lastRead, keys), allowedDirectories: ['/edited'], fileReadLineLimit: 77 };
      assert.deepStrictEqual(pick(child.result.config, keys), expected, `the settings in effect are ${JSON.stringify(pick(child.result.config, keys))}`);
      assert.deepStrictEqual(pick(child.result.onDisk, keys), expected, `config.json was replaced with ${JSON.stringify(pick(child.result.onDisk, keys))}`);
      assert.strictEqual(child.result.onDisk.sawOnboardingPage, true, 'the write made while running must land');
    } finally {
      home.cleanup();
    }
  });

  // 5. What a reset leaves besides the settings
  await check('a reset keeps the welcome page off, one corrupt copy with the damaged bytes, and says so in one log line', async () => {
    const damaged = Buffer.concat([Buffer.from('{"telemetryEnabled": false, "fileReadLineLimit": 5'), Buffer.alloc(16)]);
    const home = homeWithConfig(damaged);
    try {
      const child = runConfigManagerChild(home.env, { body: settingsAfterStartup });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      const { config, onDisk, firstRun } = child.result;
      assert.strictEqual(firstRun, false, 'a damaged config.json was taken for a first run');
      for (const [where, settings] of [['in effect', config], ['on disk', onDisk]]) {
        assert.deepStrictEqual([settings.welcomeOnboardingEligible, settings.pendingWelcomeOnboarding], [false, false],
          `the welcome page flags ${where} are ${JSON.stringify([settings.welcomeOnboardingEligible, settings.pendingWelcomeOnboarding])}: an existing install must not get it`);
      }
      const copies = corruptCopiesIn(home.configDir);
      assert.strictEqual(copies.length, 1, `the damaged file should be kept as one corrupt copy: ${copies.join(', ')}`);
      assert(fs.readFileSync(path.join(home.configDir, copies[0])).equals(damaged), 'the corrupt copy should hold the damaged bytes');
      const lines = child.stderr.split('\n').filter((line) => /corrupt/i.test(line));
      assert.strictEqual(lines.length, 1, `the log should say once what happened, it said:\n${lines.join('\n') || child.stderr}`);
    } finally {
      home.cleanup();
    }
  });

  // 6. config.json is there but can't be read (e.g. no permission, #419)
  await check('config.json that can\'t be read: left as it is, the session uses the defaults, a warning says why', async () => {
    const home = homeWithConfig(JSON.stringify({ allowedDirectories: ['/work'] }, null, 2));
    const before = fs.readFileSync(home.configPath);
    try {
      const child = runConfigManagerChild(home.env, {
        prelude: `
          const { CONFIG_FILE: unreadable } = await import(DIST + '/config.js');
          const readFile = fs.readFile;
          fs.readFile = (file, ...rest) => String(file) === unreadable
            ? Promise.reject(Object.assign(new Error("EACCES: permission denied, open '" + unreadable + "'"), { code: 'EACCES' }))
            : readFile(file, ...rest);`,
        body: settingsAfterStartup,
      });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      const { config, defaults, echoAllowed } = child.result;
      assert.deepStrictEqual([config.allowedDirectories, config.blockedCommands], [defaults.allowedDirectories, defaults.blockedCommands],
        `with a config.json that can't be read, the session uses allowedDirectories ${JSON.stringify(config.allowedDirectories)} and blockedCommands ${JSON.stringify(config.blockedCommands)} instead of the defaults`);
      assert.strictEqual(echoAllowed, true, '`echo hello` was refused');
      assert(fs.readFileSync(home.configPath).equals(before), 'a config.json that could not be read was changed');
      assert.deepStrictEqual(corruptCopiesIn(home.configDir), [], 'a config.json that could not be read is not damaged: no corrupt copy');
      assert(child.stderr.includes('config.json could not be read (EACCES: permission denied'),
        `a warning should say config.json could not be read, and why: ${child.stderr}`);
    } finally {
      home.cleanup();
    }
  });

  if (failures.length > 0) {
    console.log(`${failures.length} of ${total} cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
