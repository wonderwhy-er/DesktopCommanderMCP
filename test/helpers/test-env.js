import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Environment for one test process. The runners start every test file with it:
 * - a fresh temporary home, so Desktop Commander's config, flag cache and logs
 *   (~/.claude-server-commander) never touch the real ones
 * - telemetry off, and feature flags from a dead local address instead of the
 *   production server
 * - no FORCE_COLOR, so processes the tests start print the same plain text
 *   whichever terminal launched the run
 * Values already set by the caller win; tests that need others set them themselves.
 */
export function createTestEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-home-'));
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
