#!/usr/bin/env node

/**
 * Verify ripgrep binary availability after installation
 * This runs after npm install to warn users if ripgrep is not available
 */

import { getRipgrepPath } from '../utils/ripgrep-resolver.js';

async function verifyRipgrep() {
  try {
    const path = await getRipgrepPath();
    console.log(`✓ ripgrep found at: ${path}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('⚠ Warning: ripgrep binary not available');
    console.error(`${message}`);
    console.error('');
    console.error('Desktop Commander will not work until ripgrep is available.');
    console.error('This usually happens when npm postinstall scripts fail during npx execution.');
    console.error('');
    console.error('To fix this, install ripgrep manually:');
    console.error('  macOS: brew install ripgrep');
    console.error('  Linux: See https://github.com/BurntSushi/ripgrep#installation');
    console.error('  Windows: choco install ripgrep or download from https://github.com/BurntSushi/ripgrep/releases');
    process.exit(1);
  }
}

verifyRipgrep();
