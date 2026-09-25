import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_HOME_PREFIX = 'dc-test-home-';

/**
 * Environment for one test process. The runners start every test file with it:
 * - a fresh temporary home, so Desktop Commander's config, flag cache and logs
 *   (~/.claude-server-commander) never touch the real ones. It is given by its
 *   real path: macOS's temporary folder is under /var, a link to /private/var,
 *   and a test must not meet that link unless it makes one itself
 * - telemetry off, and feature flags from a dead local address instead of the
 *   production server
 * - no FORCE_COLOR, so processes the tests start print the same plain text
 *   whichever terminal launched the run
 * Values already set by the caller win; tests that need others set them themselves.
 */
export function createTestEnv() {
  const home = createTempDir(TEST_HOME_PREFIX);
  const { FORCE_COLOR, ...inherited } = process.env;
  const env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY ?? '1',
    DC_FLAG_URL: process.env.DC_FLAG_URL ?? 'http://127.0.0.1:9/',
  };
  return {
    env,
    home,
    // Retries: on Windows a just-exited child can still hold a file in the home for a moment
    cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/**
 * A new temporary folder (`prefix` plus random characters), by its real path.
 * macOS's temporary folder is under /var, a link to /private/var, and the
 * server works with real paths, so a test that compares or matches the paths it
 * gets back makes its folders with this, as createTestEnv() makes the home.
 */
export function createTempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * True when this process runs in a home createTestEnv() made. A test that
 * replaces files in the home (config, logs) checks it, so running it directly
 * with node can never touch the real ~/.claude-server-commander.
 */
export function isTestHome() {
  return path.basename(os.homedir()).startsWith(TEST_HOME_PREFIX);
}
