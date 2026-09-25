/**
 * #692 / #419: when config.json can't be used as it is, the settings Desktop
 * Commander falls back to must never open the whole filesystem.
 *
 * A damaged config.json is repaired at startup (kept as a copy,
 * config.json.corrupt.<time>.<pid>, and replaced by the defaults with the
 * blocked commands and allowed folders it still gives). If that repair itself
 * fails (the copy can't be made, the repaired file can't be written), the
 * session uses what the repair would have written: file tools only reach the
 * config folder unless the damaged file still gives its allowed folders, and
 * every command is blocked unless it still gives its blocked commands.
 * config.json is left as it was, so the next start repairs it again instead of
 * taking it for a first run (whose allowedDirectories [] opens every folder),
 * and keeps the copy it already made. One warning, as a log notification and
 * on stderr, says the repair failed and why. A config.json that can't be
 * read gets the same closed settings (recovered from nothing). One that is read
 * but can't be written keeps its settings in effect; changes, the client id and
 * a value set_config_value says it "changed in memory" are held (no retry loop)
 * and saved once it can be written. A config.json removed while running is
 * recreated with the defaults, not with only the value being set.
 *
 * Each case loads the config manager in a child process of its own, whose file
 * system fails the way the case needs.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createTestEnv } from './helpers/test-env.js';
import { runConfigManagerChild } from './helpers/config-child.js';
import { runIfMain } from './helpers/run-if-main.js';

/**
 * runConfigManagerChild prelude: writes to paths containing `part` fail as on
 * a full disk (fs.writeFile, and fs.open for writing, which writeFileAtomic uses)
 */
const writesFail = (part) => `
  const fail = () => Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
  const hits = (file) => String(file).includes(${JSON.stringify(part)});
  const { writeFile, open } = fs;
  fs.writeFile = (file, ...rest) => hits(file) ? fail() : writeFile(file, ...rest);
  fs.open = (file, flags, ...rest) => hits(file) && /[wa+]/.test(String(flags)) ? fail() : open(file, flags, ...rest);`;

/** runConfigManagerChild prelude: keeping a corrupt copy of config.json fails */
const copyAsideFails = `
  const { copyFile } = fs;
  fs.copyFile = (from, to, ...rest) => String(to).includes('.corrupt.')
    ? Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked, copyfile'), { code: 'EBUSY' }))
    : copyFile(from, to, ...rest);`;

/** runConfigManagerChild body: the settings in effect after startup */
const settingsInEffect = `
  const config = await configManager.getConfig();
  console.log(JSON.stringify({ allowedDirectories: config.allowedDirectories, blockedCommands: config.blockedCommands, telemetryEnabled: config.telemetryEnabled }));`;

/** A temporary home whose config.json holds `content` (bytes or text) */
function homeWithConfig(content) {
  const testEnv = createTestEnv();
  const configDir = path.join(testEnv.home, '.claude-server-commander');
  const configPath = path.join(configDir, 'config.json');
  if (content !== undefined) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, content);
  }
  return { ...testEnv, configDir, configPath };
}

const corruptCopiesIn = (configDir) => fs.readdirSync(configDir).filter((name) => name.startsWith('config.json.corrupt.'));

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

  // Nothing recoverable (NUL bytes, as a crash mid-write leaves them), and the repair
  // can't keep a copy of it
  await check('repair fails, nothing recoverable: file tools only reach the config folder, every command is blocked, a warning says so', async () => {
    const damaged = Buffer.alloc(64);
    const home = homeWithConfig(damaged);
    try {
      const child = runConfigManagerChild(home.env, { prelude: copyAsideFails, body: settingsInEffect });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      assert.deepStrictEqual(child.result.allowedDirectories, [home.configDir], `when the repair failed, allowedDirectories is ${JSON.stringify(child.result.allowedDirectories)}: file tools must only reach the config folder, not the whole filesystem`);
      assert.deepStrictEqual(child.result.blockedCommands, ['*'], `when the repair failed and no blocked commands could be recovered, blockedCommands is ${JSON.stringify(child.result.blockedCommands)} instead of ["*"] (every command blocked)`);
      assert.strictEqual(child.result.telemetryEnabled, true, 'with no telemetry opt-out in the damaged file, telemetry keeps its default (on)');
      assert(fs.readFileSync(home.configPath).equals(damaged), 'config.json changed although no copy of it could be kept');
      assert(child.stderr.includes('config.json could not be read, and repairing it failed (EBUSY') && child.stderr.includes('every command is blocked'),
        `the warning should say the repair failed, why, and what the session uses: ${child.stderr}`);
    } finally {
      home.cleanup();
    }
  });

  // The copy is kept, then the repaired config can't be written (a full disk): what
  // the damaged file still gives applies for the session
  await check('repair fails after keeping a copy: the settings it still gives apply for the session', async () => {
    const damaged = '{"blockedCommands": ["rm"], "allowedDirectories": ["/work"], "telemetryEnabled": false, BROKEN';
    const home = homeWithConfig(damaged);
    try {
      const child = runConfigManagerChild(home.env, { prelude: writesFail('.tmp'), body: settingsInEffect });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      assert.deepStrictEqual(child.result.allowedDirectories, ['/work'], `when the repair failed, allowedDirectories is ${JSON.stringify(child.result.allowedDirectories)} instead of the ["/work"] the damaged file still gives`);
      assert.deepStrictEqual(child.result.blockedCommands, ['rm'], `when the repair failed, blockedCommands is ${JSON.stringify(child.result.blockedCommands)} instead of the ["rm"] the damaged file still gives`);
      assert.strictEqual(child.result.telemetryEnabled, false, 'the damaged file turns telemetry off, but it was on for the session');
      const copies = corruptCopiesIn(home.configDir);
      assert.strictEqual(copies.length, 1, `the damaged file should be kept as one corrupt copy: ${copies.join(', ')}`);
      assert.strictEqual(fs.readFileSync(path.join(home.configDir, copies[0]), 'utf8'), damaged, 'the corrupt copy should hold the damaged text');
      assert(child.stderr.includes('config.json could not be read, and repairing it failed (ENOSPC'), `the warning should say the repair failed and why: ${child.stderr}`);
    } finally {
      home.cleanup();
    }
  });

  // The repaired config can't be written (a full disk). The next start, with space
  // again, must repair config.json, not find it missing and take it for a first run.
  await check('a repair that could not be written is done at the next start: the settings the damaged file gives, not a first run', async () => {
    const damaged = '{"blockedCommands": ["rm"], "allowedDirectories": ["/work"], BROKEN';
    const home = homeWithConfig(damaged);
    try {
      const first = runConfigManagerChild(home.env, { prelude: writesFail('.tmp'), body: 'await configManager.getConfig(); console.log("{}");' });
      assert(first.status === 0, `the first start failed (${first.status}): ${first.stderr}`);
      const afterFirst = fs.existsSync(home.configPath) ? fs.readFileSync(home.configPath, 'utf8') : null;
      const second = runConfigManagerChild(home.env, {
        body: `
          const config = await configManager.getConfig();
          console.log(JSON.stringify({ allowedDirectories: config.allowedDirectories, blockedCommands: config.blockedCommands, firstRun: configManager.isFirstRun() }));`,
      });
      assert(second.status === 0 && second.result, `the second start failed (${second.status}): ${second.stderr}`);
      assert.deepStrictEqual(second.result.allowedDirectories, ['/work'], `the start after a repair that could not be written uses allowedDirectories ${JSON.stringify(second.result.allowedDirectories)} instead of the ["/work"] the damaged file gives`);
      assert.deepStrictEqual(second.result.blockedCommands, ['rm'], `the start after a repair that could not be written uses blockedCommands ${JSON.stringify(second.result.blockedCommands)} instead of the ["rm"] the damaged file gives`);
      assert.strictEqual(second.result.firstRun, false, 'the start after a repair that could not be written was taken for a first run');
      assert.strictEqual(afterFirst, damaged, afterFirst === null
        ? 'a repair that could not be written left no config.json'
        : 'a repair that could not be written changed config.json');
      const onDisk = JSON.parse(fs.readFileSync(home.configPath, 'utf8'));
      assert.deepStrictEqual([onDisk.allowedDirectories, onDisk.blockedCommands], [['/work'], ['rm']], `config.json was repaired as ${JSON.stringify([onDisk.allowedDirectories, onDisk.blockedCommands])}`);
      const copies = corruptCopiesIn(home.configDir);
      assert.strictEqual(copies.length, 1, `the damaged file should be kept as one corrupt copy, not one per repair: ${copies.join(', ')}`);
      assert.strictEqual(fs.readFileSync(path.join(home.configDir, copies[0]), 'utf8'), damaged, 'the corrupt copy should hold the damaged text');
    } finally {
      home.cleanup();
    }
  });

  // A nested object in the damaged text holds the same keys before (or instead of) the
  // config's own fields: only the config's own fields are recovered
  await check("a repair recovers only the config's own fields, not a nested object's of the same name", async () => {
    const damaged = '{"usageStats": {"blockedCommands": [], "allowedDirectories": ["/"]}, "allowedDirectories": ["/work"], "telemetryEnabled": ';
    const home = homeWithConfig(damaged);
    try {
      const child = runConfigManagerChild(home.env, {
        body: `
          const config = await configManager.getConfig();
          console.log(JSON.stringify({ allowedDirectories: config.allowedDirectories, blockedCommands: config.blockedCommands }));`,
      });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      assert.deepStrictEqual(child.result.allowedDirectories, ['/work'], `the repair recovered allowedDirectories ${JSON.stringify(child.result.allowedDirectories)} instead of the config's own ["/work"] (["/"] is a nested object's)`);
      assert.deepStrictEqual(child.result.blockedCommands, ['*'], `the repair recovered blockedCommands ${JSON.stringify(child.result.blockedCommands)}: the config has none of its own, so every command must be blocked (["*"]), not a nested object's []`);
      const onDisk = JSON.parse(fs.readFileSync(home.configPath, 'utf8'));
      assert.deepStrictEqual([onDisk.allowedDirectories, onDisk.blockedCommands], [['/work'], ['*']], `config.json was repaired as ${JSON.stringify([onDisk.allowedDirectories, onDisk.blockedCommands])}`);
    } finally {
      home.cleanup();
    }
  });

  // #419: config.json is there but can't be read (e.g. chmod 000): there is nothing to
  // repair, and the defaults' allowedDirectories [] would open the whole filesystem
  await check('config.json can\'t be read: file tools only reach the config folder, every command is blocked, the file is left as it is, a warning says why', async () => {
    const home = homeWithConfig(JSON.stringify({ allowedDirectories: ['/work'] }, null, 2));
    const before = fs.readFileSync(home.configPath);
    try {
      const child = runConfigManagerChild(home.env, {
        prelude: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          const readFile = fs.readFile;
          fs.readFile = (file, ...rest) => String(file) === CONFIG_FILE
            ? Promise.reject(Object.assign(new Error("EACCES: permission denied, open '" + CONFIG_FILE + "'"), { code: 'EACCES' }))
            : readFile(file, ...rest);`,
        body: settingsInEffect,
      });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      assert.deepStrictEqual(child.result.allowedDirectories, [home.configDir], `with a config.json that can't be read, allowedDirectories is ${JSON.stringify(child.result.allowedDirectories)}: file tools must only reach the config folder, not the whole filesystem`);
      assert.deepStrictEqual(child.result.blockedCommands, ['*'], `with a config.json that can't be read, blockedCommands is ${JSON.stringify(child.result.blockedCommands)} instead of ["*"] (every command blocked)`);
      assert(fs.readFileSync(home.configPath).equals(before), 'a config.json that could not be read was changed');
      assert.deepStrictEqual(corruptCopiesIn(home.configDir), [], 'a config.json that could not be read is not damaged: no corrupt copy');
      assert(child.stderr.includes('config.json could not be read (EACCES: permission denied') && child.stderr.includes('every command is blocked'),
        `the warning should say config.json could not be read, why, and what the session uses: ${child.stderr}`);
    } finally {
      home.cleanup();
    }
  });

  // #419: config.json is read, but the one-time legacy migration can't be written (a
  // read-only file system; also a full disk or a lock that can't be taken). The config
  // that was read stays in effect, never the defaults' allowedDirectories [].
  await check('config.json read but not writable: its settings stay in effect, changes are held and land once it is writable', async () => {
    const legacy = JSON.stringify({ allowedDirectories: ['/work'], blockedCommands: ['rm'] }, null, 2);
    const home = homeWithConfig(legacy);
    try {
      const child = runConfigManagerChild(home.env, {
        prelude: `
          globalThis.writesFail = true;
          const { open } = fs;
          fs.open = (file, flags, ...rest) => globalThis.writesFail && String(file).endsWith('.tmp') && /[wa+]/.test(String(flags))
            ? Promise.reject(Object.assign(new Error('EROFS: read-only file system, open ' + JSON.stringify(String(file))), { code: 'EROFS' }))
            : open(file, flags, ...rest);`,
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const config = await configManager.getConfig();
          const inEffect = { allowedDirectories: config.allowedDirectories, blockedCommands: config.blockedCommands, welcomeOnboardingEligible: config.welcomeOnboardingEligible };
          // A change while the file can't be written; one 5 s check passes meanwhile
          await configManager.setValueNonBlocking('heldChange', 42);
          await sleep(6000);
          const unchangedWhileReadOnly = fsSync.readFileSync(CONFIG_FILE, 'utf8') === ${JSON.stringify(legacy)};
          // The file system is writable again
          globalThis.writesFail = false;
          const writableAt = Date.now();
          let landed = null;
          while (!landed && Date.now() - writableAt < 15000) {
            await sleep(200);
            try {
              const onDisk = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
              if (onDisk.heldChange === 42) landed = onDisk;
            } catch {
              // mid-write: read again
            }
          }
          console.log(JSON.stringify({ inEffect, unchangedWhileReadOnly, landed }));`,
      });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      const { inEffect, unchangedWhileReadOnly, landed } = child.result;
      assert.deepStrictEqual(inEffect.allowedDirectories, ['/work'], `with a config.json that could be read but not written, allowedDirectories is ${JSON.stringify(inEffect.allowedDirectories)} instead of the user's ["/work"]`);
      assert.deepStrictEqual(inEffect.blockedCommands, ['rm'], `with a config.json that could be read but not written, blockedCommands is ${JSON.stringify(inEffect.blockedCommands)} instead of the user's ["rm"]`);
      assert.strictEqual(inEffect.welcomeOnboardingEligible, false, 'the one-time migration should apply in memory (no welcome page for an existing install)');
      const retries = (child.stderr.match(/Failed to save config \(background\), will retry/g) ?? []).length;
      assert.strictEqual(retries, 0, `while config.json could not be written, the background save was retried ${retries} times in 6 s`);
      assert(child.stderr.includes("can't be saved until config.json is writable") && child.stderr.includes('EROFS'),
        `the warning should say settings changes can't be saved until config.json is writable, and why: ${child.stderr}`);
      assert(unchangedWhileReadOnly, 'config.json changed while it could not be written');
      assert(landed, 'the change held while config.json could not be written was still not saved 15 s after it was writable again');
      assert.strictEqual(landed.welcomeOnboardingEligible, false, 'the one-time migration should be saved with the held changes');
      assert.deepStrictEqual([landed.allowedDirectories, landed.blockedCommands], [['/work'], ['rm']], 'saving the held changes must keep the user\'s settings');
    } finally {
      home.cleanup();
    }
  });

  // The startup repair failed (the repaired config can't be written): the session has
  // no client id, and telemetry asks for one on every event
  await check('after a failed startup repair: the client id is kept for the session, and saved with the recovered settings once writes work', async () => {
    const home = homeWithConfig('{"blockedCommands": ["rm"], "allowedDirectories": ["/work"], BROKEN');
    try {
      const child = runConfigManagerChild(home.env, {
        prelude: `
          globalThis.writesFail = true;
          const { open } = fs;
          fs.open = (file, flags, ...rest) => globalThis.writesFail && String(file).endsWith('.tmp') && /[wa+]/.test(String(flags))
            ? Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
            : open(file, flags, ...rest);`,
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          await configManager.getConfig();
          const ids = [];
          let error = null;
          try {
            ids.push(await configManager.getOrCreateClientId());
            ids.push(await configManager.getOrCreateClientId());
          } catch (e) {
            error = e.message;
          }
          // Space again
          globalThis.writesFail = false;
          let saved = null;
          for (let i = 0; i < 150 && !saved; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            try {
              const onDisk = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
              if (onDisk.clientId) saved = onDisk;
            } catch {
              // not there yet, or mid-write: read again
            }
          }
          console.log(JSON.stringify({ ids, error, saved }));`,
      });
      assert(child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      const { ids, error, saved } = child.result;
      assert.strictEqual(error, null, `after a failed startup repair, asking for the client id failed: ${error}`);
      assert(ids[0] && ids[0] === ids[1], `after a failed startup repair, the client id changed between calls: ${JSON.stringify(ids)}`);
      assert(saved, 'the client id used after the failed repair was not saved within 15 s once writes worked again');
      assert.strictEqual(saved.clientId, ids[0], `the client id saved is ${saved.clientId}, not the one used for the session (${ids[0]})`);
      assert.deepStrictEqual([saved.allowedDirectories, saved.blockedCommands], [['/work'], ['rm']],
        `config.json was repaired with ${JSON.stringify([saved.allowedDirectories, saved.blockedCommands])} instead of the recovered ["/work"] and ["rm"]`);
    } finally {
      home.cleanup();
    }
  });

  // set_config_value while config.json can't be written answers "Value changed in memory
  // but couldn't be saved to disk": the value must then really be in effect
  await check('config.json not writable: the value set_config_value says it changed in memory is in effect, and saved once writable', async () => {
    const home = homeWithConfig(JSON.stringify({ allowedDirectories: ['/work'], blockedCommands: ['rm'], pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false }, null, 2));
    const inside = path.join(home.home, 'inside');
    try {
      const child = runConfigManagerChild(home.env, {
        prelude: `
          globalThis.writesFail = true;
          const { open } = fs;
          fs.open = (file, flags, ...rest) => globalThis.writesFail && String(file).endsWith('.tmp') && /[wa+]/.test(String(flags))
            ? Promise.reject(Object.assign(new Error('EROFS: read-only file system, open ' + JSON.stringify(String(file))), { code: 'EROFS' }))
            : open(file, flags, ...rest);`,
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          const { setConfigValue } = await import(DIST + '/tools/config.js');
          await configManager.getConfig();
          const result = await setConfigValue({ key: 'allowedDirectories', value: [${JSON.stringify(inside)}] });
          const answer = result.content?.[0]?.text ?? '';
          const inEffect = (await configManager.getConfig()).allowedDirectories;
          globalThis.writesFail = false;
          let saved = null;
          for (let i = 0; i < 150 && !saved; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            try {
              const onDisk = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
              if (onDisk.allowedDirectories?.[0] === ${JSON.stringify(inside)}) saved = onDisk;
            } catch {
              // mid-write: read again
            }
          }
          console.log(JSON.stringify({ answer, inEffect, saved }));`,
      });
      assert(child.status === 0 && child.result, `the child failed (${child.status}): ${child.stderr}`);
      const { answer, inEffect, saved } = child.result;
      assert(answer.startsWith("Value changed in memory but couldn't be saved to disk"), `set_config_value on a config.json that can't be written answered: ${answer}`);
      assert.deepStrictEqual(inEffect, [inside], `set_config_value answered "Value changed in memory", but allowedDirectories in effect is ${JSON.stringify(inEffect)}`);
      assert(saved, 'the value set_config_value changed in memory was not saved within 15 s once config.json was writable');
      assert.deepStrictEqual(saved.blockedCommands, ['rm'], 'saving the held value must keep the user\'s other settings');
    } finally {
      home.cleanup();
    }
  });

  // config.json removed while Desktop Commander runs (e.g. a damaged one moved aside by
  // hand): the next write must not recreate it with nothing but the value it sets
  await check('config.json removed while running: the next write creates it with the defaults, blocked commands included', async () => {
    const home = homeWithConfig(JSON.stringify({ pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false }, null, 2));
    try {
      const child = runConfigManagerChild(home.env, {
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          const { commandManager } = await import(DIST + '/command-manager.js');
          await configManager.getConfig();
          fsSync.rmSync(CONFIG_FILE);
          await configManager.setValue('fileReadLineLimit', 500);
          const onDisk = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
          const sudoAllowed = await commandManager.validateCommand('sudo ls');
          console.log(JSON.stringify({ onDisk, sudoAllowed }));`,
      });
      assert(child.status === 0 && child.result, `the child failed (${child.status}): ${child.stderr}`);
      const { onDisk, sudoAllowed } = child.result;
      assert.strictEqual(onDisk.fileReadLineLimit, 500, 'the write must land');
      assert(Array.isArray(onDisk.blockedCommands) && onDisk.blockedCommands.includes('sudo'),
        `config.json removed while running was recreated as ${JSON.stringify(onDisk)}: without the default blocked commands, nothing is blocked`);
      assert.strictEqual(sudoAllowed, false, '`sudo ls` was allowed after config.json was recreated');
    } finally {
      home.cleanup();
    }
  });

  // config.json damaged while running (a write cut short), in a way that leaves no
  // "telemetryEnabled": false in it: the repair must keep the settings the process
  // last read, not bring back the defaults (telemetry on, default line limits, ...)
  await check('config.json damaged while running: the repair keeps the settings last read, telemetry off included', async () => {
    const clientId = '0b7f9a52-5a3e-4c6e-9d59-3f1a2b4c5d6e';
    const settings = {
      clientId, telemetryEnabled: false, fileReadLineLimit: 123, fileWriteLineLimit: 45, defaultShell: 'test-shell',
      allowedDirectories: ['/work'], blockedCommands: ['rm'], pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false,
    };
    const home = homeWithConfig(JSON.stringify(settings, null, 2));
    try {
      const child = runConfigManagerChild(home.env, {
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          await configManager.getConfig();
          // Cut short before telemetryEnabled
          fsSync.writeFileSync(CONFIG_FILE, '{\\n  "allowedDirectories": ["/work"],\\n  "blockedCommands": ["rm"],\\n  "fileReadLin');
          await configManager.setValue('sawOnboardingPage', true);
          const inEffect = await configManager.getConfig();
          const onDisk = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
          console.log(JSON.stringify({ inEffect, onDisk }));`,
      });
      assert(child.status === 0 && child.result, `the child failed (${child.status}): ${child.stderr}`);
      const kept = ({ clientId, telemetryEnabled, fileReadLineLimit, fileWriteLineLimit, defaultShell, allowedDirectories, blockedCommands }) =>
        ({ clientId, telemetryEnabled, fileReadLineLimit, fileWriteLineLimit, defaultShell, allowedDirectories, blockedCommands });
      const expected = kept(settings);
      assert.deepStrictEqual(kept(child.result.onDisk), expected, `config.json was repaired as ${JSON.stringify(kept(child.result.onDisk))}`);
      assert.deepStrictEqual(kept(child.result.inEffect), expected, `the settings in effect after the repair are ${JSON.stringify(kept(child.result.inEffect))}`);
      assert.strictEqual(child.result.onDisk.sawOnboardingPage, true, 'the write must land');
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
