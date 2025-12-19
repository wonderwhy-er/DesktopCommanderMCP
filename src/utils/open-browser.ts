import { execFile, spawn } from 'child_process';
import os from 'os';
import { logToStderr } from './logger.js';

/**
 * Open a URL in the default browser (cross-platform)
 * Uses execFile/spawn with args array to avoid shell injection
 */
export async function openBrowser(url: string): Promise<void> {
  const platform = os.platform();
  
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null) => {
      if (error) {
        logToStderr('error', `Failed to open browser: ${error.message}`);
        reject(error);
      } else {
        logToStderr('info', `Opened browser to: ${url}`);
        resolve();
      }
    };

    switch (platform) {
      case 'darwin':
        execFile('open', [url], callback);
        break;
      case 'win32':
        // Windows 'start' is a shell builtin, use spawn with shell but pass URL as separate arg
        spawn('cmd', ['/c', 'start', '', url], { shell: false }).on('close', (code) => {
          code === 0 ? resolve() : reject(new Error(`Exit code ${code}`));
        });
        break;
      default:
        execFile('xdg-open', [url], callback);
        break;
    }
  });
}

/**
 * Open the Desktop Commander welcome page
 */
export async function openWelcomePage(): Promise<void> {
  const url = 'https://desktopcommander.app/welcome/';
  await openBrowser(url);
}
