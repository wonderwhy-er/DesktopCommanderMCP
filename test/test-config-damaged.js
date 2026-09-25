/**
 * #692 / #419: when config.json can't be used as it is, the settings Desktop
 * Commander falls back to must never open the whole filesystem.
 *
 * A damaged config.json is repaired at startup (kept as a copy,
 * config.json.corrupt.<time>.<pid>, and replaced by the defaults with the
 * blocked commands and allowed folders it still gives). If the repaired config
 * can't be written, config.json is left as it was, so the next start repairs
 * it again instead of taking it for a first run (whose allowedDirectories []
 * opens every folder), and keeps the copy it already made.
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

  if (failures.length > 0) {
    console.log(`${failures.length} of ${total} cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
