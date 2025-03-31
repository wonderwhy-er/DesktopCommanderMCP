#!/usr/bin/env node

import { FilteredStdioServerTransport } from './custom-stdio.js';
import { server } from './server.js';
import { commandManager } from './command-manager.js';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { platform } from 'os';
import { capture } from './utils.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isWindows = platform() === 'win32';

// Helper function to properly convert file paths to URLs, especially for Windows
function createFileURL(filePath: string): URL {
  if (isWindows) {
    // Ensure path uses forward slashes for URL format
    const normalizedPath = filePath.replace(/\\/g, '/');
    // Ensure path has proper file:// prefix
    if (normalizedPath.startsWith('/')) {
      return new URL(`file://${normalizedPath}`);
    } else {
      return new URL(`file:///${normalizedPath}`);
    }
  } else {
    // For non-Windows, we can use the built-in function
    return pathToFileURL(filePath);
  }
}

async function runSetup() {
  try {
    // Fix for Windows ESM path issue
    const setupScriptPath = join(__dirname, 'setup-claude-server.js');
    const setupScriptUrl = createFileURL(setupScriptPath);
    
    // Now import using the URL format
    const { default: setupModule } = await import(setupScriptUrl.href);
    if (typeof setupModule === 'function') {
      await setupModule();
    }
  } catch (error) {
    console.error('Error running setup:', error);
    process.exit(1);
  }
}

async function runServer() {
  try {
    const transport = new FilteredStdioServerTransport();

    console.log("start")
    // Check if first argument is "setup"
    if (process.argv[2] === 'setup') {
      await runSetup();
      return;
    }
    
    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        process.stderr.write(`[desktop-commander] JSON parsing error: ${errorMessage}\n`);
        return; // Don't exit on JSON parsing errors
      }

      capture('run_server_uncaught_exception', {
        error: errorMessage
      });

      process.stderr.write(`[desktop-commander] Uncaught exception: ${errorMessage}\n`);
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', async (reason) => {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      
      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        process.stderr.write(`[desktop-commander] JSON parsing rejection: ${errorMessage}\n`);
        return; // Don't exit on JSON parsing errors
      }

      capture('run_server_unhandled_rejection', {
        error: errorMessage
      });

      process.stderr.write(`[desktop-commander] Unhandled rejection: ${errorMessage}\n`);
      process.exit(1);
    });


    
    // Load blocked commands from config file
    await commandManager.loadBlockedCommands();

    await server.connect(transport);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(JSON.stringify({
      type: 'error',
      timestamp: new Date().toISOString(),
      message: `Failed to start server: ${errorMessage}`
    }) + '\n');

    capture('run_server_failed_start_error', {
      error: errorMessage
    });
    process.exit(1);
  }
}

runServer().catch(async (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  process.stderr.write(JSON.stringify({
    type: 'error',
    timestamp: new Date().toISOString(),
    message: `Fatal error running server: ${errorMessage}`
  }) + '\n');


  capture('run_server_fatal_error', {
    error: errorMessage
  });
  process.exit(1);
});