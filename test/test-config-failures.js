/**
 * Four ways config.json can fail Desktop Commander, and what the user keeps:
 *
 * 1. A corrupt config.json that can't be read again while it is recovered (EBUSY:
 *    a file scanner holds it) is not recovered as if it were empty, which would
 *    write the defaults over the settings still readable in it. It is left as it
 *    is, and the session uses those settings, with a warning.
 * 2. A config.json removed while running is recreated, but not as a new install:
 *    the welcome page stays off at the next start.
 * 3. While saves fail (a full disk), asking for the client id doesn't try a
 *    write that fails: the id is kept for the session and saved with the other
 *    queued changes once config.json can be written.
 * 4. A config.json the user may not read (#419): the server starts with the
 *    welcome page off, and config.json is left as it is.
 *
 * Cases 1-3 load the config manager in a child process of their own, case 4
 * the server; each in a temporary home.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createTestEnv } from './helpers/test-env.js';
import { runConfigManagerChild } from './helpers/config-child.js';
import { startServerLikeRemote } from './helpers/mcp-server.js';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';

/** Takes this user's permission to read `file` away; returns what gives it back */
function denyRead(file) {
  if (process.platform === 'win32') {
    const user = os.userInfo().username;
    execFileSync('icacls', [file, '/deny', `${user}:(R)`], { stdio: 'ignore' });
    return () => execFileSync('icacls', [file, '/remove:d', user], { stdio: 'ignore' });
  }
  fs.chmodSync(file, 0o000);
  return () => fs.chmodSync(file, 0o644);
}

function canRead(file) {
  try {
    fs.readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

/** A temporary home whose config.json holds `content` */
function homeWithConfig(content) {
  const testEnv = createTestEnv();
  const configDir = path.join(testEnv.home, '.claude-server-commander');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, content);
  return { ...testEnv, configDir, configPath };
}

async function run() {
  const failures = [];
  let total = 0;
  const check = async (name, test) => {
    total++;
    try {
      if (await test() === SKIPPED) return;
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`✗ ${name}\n  ${error.message}`);
    }
  };

  // 1. The recovery reads config.json's bytes, and that read fails
  await check('a corrupt config.json that fails to read during recovery is left as it is; the session uses the settings still readable in it', async () => {
    const corrupt = '{"allowedDirectories": ["/work"], "blockedCommands": ["rm"], BROKEN';
    const home = homeWithConfig(corrupt);
    try {
      const child = runConfigManagerChild(home.env, {
        prelude: `
          const { CONFIG_FILE: busyFile } = await import(DIST + '/config.js');
          const readFile = fs.readFile;
          // Reading it as bytes (not as text) fails, as when a file scanner holds it
          fs.readFile = (file, ...rest) => String(file) === busyFile && rest.length === 0
            ? Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked, open '" + busyFile + "'"), { code: 'EBUSY' }))
            : readFile(file, ...rest);`,
        body: `
          const config = await configManager.getConfig();
          console.log(JSON.stringify({ allowedDirectories: config.allowedDirectories, blockedCommands: config.blockedCommands }));`,
      });
      assert(child.status === 0 && child.result, `loading the config failed (${child.status}): ${child.stderr}`);
      assert.deepStrictEqual([child.result.allowedDirectories, child.result.blockedCommands], [['/work'], ['rm']],
        `the session uses ${JSON.stringify([child.result.allowedDirectories, child.result.blockedCommands])} instead of the ["/work"] and ["rm"] still readable in config.json`);
      assert.strictEqual(fs.readFileSync(home.configPath, 'utf8'), corrupt, 'config.json was rewritten although it could not be read');
      assert(child.stderr.includes('config.json could not be parsed, and replacing it failed (EBUSY'),
        `a warning should say the recovery failed, and why: ${child.stderr}`);
    } finally {
      home.cleanup();
    }
  });

  // 2. Removed while running (e.g. moved aside by hand), then a setting changes
  await check('config.json removed while running is recreated with the welcome page off', async () => {
    const home = homeWithConfig(JSON.stringify({ allowedDirectories: ['/work'], pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false }, null, 2));
    try {
      const child = runConfigManagerChild(home.env, {
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          await configManager.getConfig();
          fsSync.rmSync(CONFIG_FILE);
          await configManager.setValue('fileReadLineLimit', 500);
          console.log(JSON.stringify(JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'))));`,
      });
      assert(child.status === 0 && child.result, `the child failed (${child.status}): ${child.stderr}`);
      const onDisk = child.result;
      assert.strictEqual(onDisk.fileReadLineLimit, 500, 'the write must land');
      assert.deepStrictEqual([onDisk.welcomeOnboardingEligible, onDisk.pendingWelcomeOnboarding], [false, false],
        `config.json recreated while running has the welcome page flags ${JSON.stringify([onDisk.welcomeOnboardingEligible, onDisk.pendingWelcomeOnboarding])}: the next start would show the welcome page to an existing install`);
    } finally {
      home.cleanup();
    }
  });

  // 3. A background save has failed (a full disk); then the client id is asked for
  await check('while saves fail, the client id is kept for the session without a failing write, and saved once writes work', async () => {
    const home = homeWithConfig(JSON.stringify({ allowedDirectories: ['/work'], pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false }, null, 2));
    try {
      const child = runConfigManagerChild(home.env, {
        prelude: `
          globalThis.writesFail = false;
          const { open } = fs;
          fs.open = (file, flags, ...rest) => globalThis.writesFail && String(file).endsWith('.tmp') && /[wa+]/.test(String(flags))
            ? Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
            : open(file, flags, ...rest);
          let saveFailed;
          globalThis.firstSaveFailure = new Promise((resolve) => { saveFailed = resolve; });
          const logError = console.error;
          console.error = (...args) => {
            if (/Failed to save config \\(background\\)/.test(String(args[0]))) saveFailed();
            logError(...args);
          };`,
        body: `
          const { CONFIG_FILE } = await import(DIST + '/config.js');
          await configManager.getConfig();
          globalThis.writesFail = true;
          await configManager.setValueNonBlocking('queuedChange', 1);
          await globalThis.firstSaveFailure;
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
              if (onDisk.clientId && onDisk.queuedChange === 1) saved = onDisk;
            } catch {
              // mid-write: read again
            }
          }
          console.log(JSON.stringify({ ids, error, saved }));`,
      });
      assert(child.status === 0 && child.result, `the child failed (${child.status}): ${child.stderr}`);
      const { ids, error, saved } = child.result;
      assert.strictEqual(error, null, `asking for the client id after a failed save tried a write, and it failed: ${error}`);
      assert(ids[0] && ids[0] === ids[1], `the client id changed between calls: ${JSON.stringify(ids)}`);
      assert(saved, 'the client id and the queued change were not saved within 15 s once writes worked again');
      assert.strictEqual(saved.clientId, ids[0], `the client id saved is ${saved.clientId}, not the one used for the session (${ids[0]})`);
      assert.deepStrictEqual(saved.allowedDirectories, ['/work'], 'saving the queued changes must keep the user\'s settings');
    } finally {
      home.cleanup();
    }
  });

  // 4. config.json is there, but this user may not read it (#419)
  await check("a config.json that can't be read: the server starts with the welcome page off, and config.json is left as it is", async () => {
    const original = JSON.stringify({ allowedDirectories: ['/work'] });
    const home = homeWithConfig(original);
    try {
      const restore = denyRead(home.configPath);
      try {
        if (canRead(home.configPath)) return skip('test-config-failures.js: this user reads config.json whatever its permissions');
        const server = await startServerLikeRemote(home.env);
        try {
          const { config } = (await server.client.callTool({ name: 'get_config', arguments: {} })).structuredContent;
          assert.deepStrictEqual([config.welcomeOnboardingEligible, config.pendingWelcomeOnboarding], [false, false],
            'an existing install must start with the welcome page off');
        } finally {
          await server.close();
        }
      } finally {
        restore();
      }
      assert.strictEqual(fs.readFileSync(home.configPath, 'utf8'), original, 'config.json must be left as it is');
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
