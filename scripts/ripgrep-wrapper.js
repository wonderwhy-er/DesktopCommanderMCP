// Runtime platform detection wrapper for @vscode/ripgrep
// This replaces the original index.js to support cross-platform MCPB bundles

const os = require('os');
const path = require('path');
const fs = require('fs');

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
const rgPath = path.join(__dirname, '..', 'bin', binaryName);

// Verify binary exists
if (!fs.existsSync(rgPath)) {
  // Try fallback to original rg location
  const fallbackPath = path.join(__dirname, '..', 'bin', isWindows ? 'rg.exe' : 'rg');
  if (fs.existsSync(fallbackPath)) {
    module.exports.rgPath = fallbackPath;
  } else {
    throw new Error(`ripgrep binary not found for platform ${target}: ${rgPath}`);
  }
} else {
  module.exports.rgPath = rgPath;
}
