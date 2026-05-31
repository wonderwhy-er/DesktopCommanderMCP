// Runtime platform detection wrapper for @vscode/ripgrep.
// This replaces the package's index.js in MCPB bundles so a single bundle can
// resolve the correct ripgrep binary at runtime across platforms.
//
// IMPORTANT: @vscode/ripgrep 1.18.0+ ships package.json with "type": "module",
// so this wrapper MUST be ESM. The previous CommonJS version (require /
// module.exports) threw "require is not defined in ES module scope" the moment
// the dependency went ESM. That error was swallowed by the resolver's try/catch
// and surfaced as a misleading "ripgrep binary not found", silently breaking
// search on Windows even though the bundled binaries were present.

import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getTarget() {
  const arch = process.env.npm_config_arch || os.arch();

  switch (os.platform()) {
    case 'darwin':
      return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    case 'win32':
      return arch === 'x64' ? 'x86_64-pc-windows-msvc' :
             arch === 'arm64' ? 'aarch64-pc-windows-msvc' :
             'i686-pc-windows-msvc';
    case 'linux':
      return arch === 'x64' ? 'x86_64-unknown-linux-musl' :
             arch === 'arm' ? 'arm-unknown-linux-gnueabihf' :
             arch === 'armv7l' ? 'arm-unknown-linux-gnueabihf' :
             arch === 'arm64' ? 'aarch64-unknown-linux-musl' :
             arch === 'ppc64' ? 'powerpc64le-unknown-linux-gnu' :
             arch === 's390x' ? 's390x-unknown-linux-gnu' :
             'i686-unknown-linux-musl';
    default:
      throw new Error('Unknown platform: ' + os.platform());
  }
}

const target = getTarget();
const isWindows = os.platform() === 'win32';
const binaryName = isWindows ? `rg-${target}.exe` : `rg-${target}`;
// __dirname is lib/, so go up one level to reach bin/
let resolvedRgPath = path.join(__dirname, '..', 'bin', binaryName);

if (!fs.existsSync(resolvedRgPath)) {
  // Fallback to a plain rg binary if the platform-specific one is missing
  const fallbackPath = path.join(__dirname, '..', 'bin', isWindows ? 'rg.exe' : 'rg');
  if (!fs.existsSync(fallbackPath)) {
    throw new Error(`ripgrep binary not found for platform ${target}: ${resolvedRgPath}`);
  }
  resolvedRgPath = fallbackPath;
}

// Ensure executable permissions on Unix systems.
// Fixes issues when extracting from zip archives that don't preserve permissions.
if (!isWindows) {
  try {
    fs.chmodSync(resolvedRgPath, 0o755);
  } catch (err) {
    // Ignore permission errors - might not have write access
  }
}

export const rgPath = resolvedRgPath;
