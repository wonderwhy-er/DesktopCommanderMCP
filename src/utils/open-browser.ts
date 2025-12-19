import { exec } from 'child_process';
import os from 'os';
import { logToStderr } from './logger.js';

/**
 * Open a URL in the default browser (cross-platform)
 */
export async function openBrowser(url: string): Promise<void> {
  const platform = os.platform();
  
  let command: string;
  
  switch (platform) {
    case 'darwin': // macOS
      command = `open "${url}"`;
      break;
    case 'win32': // Windows
      command = `start "" "${url}"`;
      break;
    default: // Linux and others
      command = `xdg-open "${url}"`;
      break;
  }
  
  return new Promise((resolve, reject) => {
    exec(command, (error) => {
      if (error) {
        logToStderr('error', `Failed to open browser: ${error.message}`);
        reject(error);
      } else {
        logToStderr('info', `Opened browser to: ${url}`);
        resolve();
      }
    });
  });
}

/**
 * Open the Desktop Commander welcome page
 * Uses localhost for development, production URL otherwise
 */
export async function openWelcomePage(): Promise<void> {
  const baseUrl = 'https://desktopcommander.app';
  
  // TODO: Change back to /welcome/ after testing
  const url = `${baseUrl}/welcome-v6/?ref=first-run`;
  
  await openBrowser(url);
}
