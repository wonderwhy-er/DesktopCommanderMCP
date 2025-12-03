import { execSync } from 'child_process';
import { existsSync, chmodSync } from 'fs';
import path from 'path';
import os from 'os';

let cachedRgPath: string | null = null;

/**
 * Resolve ripgrep binary path with multiple fallback strategies
 * This handles cases where @vscode/ripgrep postinstall fails in npx environments
 */
export async function getRipgrepPath(): Promise<string> {
  if (cachedRgPath) {
    return cachedRgPath;
  }

  // Strategy 1: Try @vscode/ripgrep package
  try {
    const { rgPath } = await import('@vscode/ripgrep');
    if (existsSync(rgPath)) {
      // Ensure executable permissions on Unix systems
      if (process.platform !== 'win32') {
        try {
          chmodSync(rgPath, 0o755);
        } catch (e) {
          // Ignore chmod errors - might not have write access
        }
      }
      cachedRgPath = rgPath;
      return rgPath;
    }
  } catch (e) {
    // @vscode/ripgrep import or binary resolution failed, continue to fallbacks
  }

  // Strategy 2: Try system ripgrep using 'which' (Unix) or 'where' (Windows)
  try {
    const systemRg = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${whichCmd} ${systemRg}`, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    if (result && existsSync(result)) {
      cachedRgPath = result;
      return result;
    }
  } catch (e) {
    // System rg not found via which
  }

  // Strategy 3: Try common installation paths
  const commonPaths: string[] = [];

  if (process.platform === 'win32') {
    commonPaths.push(
      'C:\\Program Files\\Ripgrep\\rg.exe',
      'C:\\Program Files (x86)\\Ripgrep\\rg.exe',
      path.join(os.homedir(), 'scoop', 'apps', 'ripgrep', 'current', 'rg.exe'),
      path.join(os.homedir(), '.cargo', 'bin', 'rg.exe')
    );
  } else {
    commonPaths.push(
      '/usr/local/bin/rg',
      '/usr/bin/rg',
      path.join(os.homedir(), '.cargo', 'bin', 'rg'),
      '/opt/homebrew/bin/rg' // Apple Silicon Homebrew
    );
  }

  for (const possiblePath of commonPaths) {
    if (existsSync(possiblePath)) {
      cachedRgPath = possiblePath;
      return possiblePath;
    }
  }

  // No ripgrep found - provide helpful error message
  throw new Error(
    'ripgrep binary not found. Desktop Commander requires ripgrep to perform searches. ' +
    'Please install ripgrep:\n' +
    '  macOS: brew install ripgrep\n' +
    '  Linux: See https://github.com/BurntSushi/ripgrep#installation\n' +
    '  Windows: choco install ripgrep or download from https://github.com/BurntSushi/ripgrep/releases'
  );
}

/**
 * Clear the cached ripgrep path (useful for testing)
 */
export function clearRipgrepCache(): void {
  cachedRgPath = null;
}
