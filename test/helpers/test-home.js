import fs from 'fs';
import path from 'path';
import { createTestEnv, LEFT_OUT } from './test-env.js';

/**
 * Loaded with --import into every test file's process that the runners start
 * through node:test (helpers/node-test-runner.js passes it as execArgv). Before
 * the file's own imports run, it gives the process the environment the runners
 * have always given each file: createTestEnv()'s temporary home, telemetry off,
 * none of the variables it leaves out (FORCE_COLOR, XDG_CONFIG_HOME). It also
 * points skip() at this file's own record
 * (DC_TEST_SKIP_FILE), in the run's folder (DC_TEST_RUN_DIR).
 *
 * A Node process the test file starts with fork() gets the same execArgv, so this
 * runs there too. It then changes nothing: that process keeps the environment the
 * test gave it (test-config-client-id-cross-process.js gives 8 children one home).
 */
if (!process.env.DC_TEST_HOME_SET) {
  const testEnv = createTestEnv();
  for (const name of LEFT_OUT) delete process.env[name];
  Object.assign(process.env, testEnv.env, { DC_TEST_HOME_SET: '1' });

  const runDir = process.env.DC_TEST_RUN_DIR;
  if (runDir && process.argv[1]) {
    const name = path.basename(process.argv[1]);
    process.env.DC_TEST_SKIP_FILE = path.join(runDir, `${name}.skips.txt`);
    // The runner removes the home after the run too, in case this process is stopped before its exit handler runs
    fs.writeFileSync(path.join(runDir, `${name}.home.txt`), testEnv.home);
  }

  process.on('exit', () => {
    try {
      testEnv.cleanup();
    } catch {
      // A process the test started can still hold a file in the home; the runner removes it after the run
    }
  });
}
