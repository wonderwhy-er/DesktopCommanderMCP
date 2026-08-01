import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runLinuxServiceInstaller(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('The linux-service command can only run on Linux.');
  }

  const scriptPath = path.resolve(__dirname, '../linux/install-linux-service.sh');
  await fs.access(scriptPath);
  const args = process.argv.slice(3);

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`Linux service installer exited with code ${exitCode}`);
  }
}
