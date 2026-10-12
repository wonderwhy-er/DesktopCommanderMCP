import { getSystemInfo } from '../../dist/utils/system-info.js';

/**
 * The Python 3 command the server itself detected (system info's pythonInfo),
 * for tests that start a Python REPL, or null when there is none (the test
 * skips). A hardcoded `python3` doesn't run on Windows, where it is often the
 * Microsoft Store alias ("Python was not found", exit code 49), while the
 * server finds `python` or `py`.
 */
export function pythonCommand() {
  const { pythonInfo } = getSystemInfo();
  return pythonInfo?.available ? pythonInfo.command : null;
}
