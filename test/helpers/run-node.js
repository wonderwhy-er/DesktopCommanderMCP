import { spawn } from 'child_process';

/**
 * Runs a Node.js child process (process.execPath with `args`) and resolves with
 * what spawnSync returns: { status, signal, stdout, stderr }. Unlike spawnSync,
 * it doesn't freeze this process while the child runs. A test that searched
 * in-process has telemetry captures in flight, each a locked config write; frozen
 * by spawnSync, such a write keeps the config lock for the child's whole run, the
 * child's own config writes wait on it for 30 s or more, and this process can die
 * of ECOMPROMISED afterwards. Here the write finishes and releases the lock.
 * After `timeoutMs` the child is killed (SIGTERM), as spawnSync's timeout does.
 */
export function runNode(args, { env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
