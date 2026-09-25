import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const DIST = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')).href;

/**
 * Loads the built config manager (dist/config-manager.js) in a child process
 * of its own, with `env` (a test home), so a test can make the file system
 * fail the way it needs before the config manager uses it.
 *
 * The script sees `fs` (fs/promises, the object the config manager calls:
 * patch its methods in `prelude`), `fsSync` (fs), `DIST` (the dist/ folder's
 * URL, for more imports) and, in `body`, `configManager`. `body` prints its
 * result as the last stdout line, as JSON.
 * Returns { status, result (that JSON, or undefined), stdout, stderr }.
 */
export function runConfigManagerChild(env, { prelude = '', body }) {
  const script = `
    import fs from 'fs/promises';
    import fsSync from 'fs';
    const DIST = ${JSON.stringify(DIST)};
    ${prelude}
    const { configManager } = await import(DIST + '/config-manager.js');
    ${body}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60_000 });
  const last = (child.stdout ?? '').trim().split('\n').pop();
  let result;
  try {
    result = JSON.parse(last);
  } catch {
    // No JSON result line: the caller reports status, stdout and stderr instead
  }
  return { status: child.status, result, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}
