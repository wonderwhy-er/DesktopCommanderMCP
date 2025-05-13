#!/usr/bin/env node
/**
 * Helper script to start the Desktop Commander with SSE enabled
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default port for the HTTP server
const DEFAULT_PORT = 3000;

// Get port from command line args or use default
const args = process.argv.slice(2);
let port = DEFAULT_PORT;
const portArgIndex = args.indexOf('--port');
if (portArgIndex !== -1 && portArgIndex + 1 < args.length) {
  const portArg = parseInt(args[portArgIndex + 1], 10);
  if (!isNaN(portArg)) {
    port = portArg;
  }
}

// Determine if we should run in HTTP-only mode
const httpOnly = args.includes('--http-only') || args.includes('--sse-only');

// Start the main server script with appropriate arguments
const serverProcess = spawn('node', [
  join(__dirname, 'index.js'),
  '--sse',
  '--port', port.toString(),
  ...(httpOnly ? ['--sse-only'] : []),
  ...args.filter(arg => 
    arg !== '--port' && 
    arg !== (portArgIndex !== -1 ? args[portArgIndex + 1] : '') && 
    arg !== '--http-only' && 
    arg !== '--sse-only'
  )
], {
  stdio: 'inherit'
});

// Forward signals to child process
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(signal => {
  process.on(signal, () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
    }
  });
});

// Exit with the same code as the child process
serverProcess.on('exit', (code) => {
  process.exit(code ?? 0);
});
