#!/usr/bin/env node

import { FilteredStdioServerTransport } from './custom-stdio.js';
import { server } from './server.js';
import { commandManager } from './command-manager.js';
import { configManager } from './config-manager.js';
import { runSetup } from './npm-scripts/setup.js';
import { runUninstall } from './npm-scripts/uninstall.js';
import { capture } from './utils/capture.js';

async function runServer() {
  try {
    // Check if first argument is "setup"
    if (process.argv[2] === 'setup') {
      await runSetup();
      return;
    }

    // Check if first argument is "remove"
    if (process.argv[2] === 'remove') {
      await runUninstall();
      return;
    }

      try {
          console.error("Loading configuration...");
          await configManager.loadConfig();
          console.error("Configuration loaded successfully");
      } catch (configError) {
          console.error(`Failed to load configuration: ${configError instanceof Error ? configError.message : String(configError)}`);
          console.error(configError instanceof Error && configError.stack ? configError.stack : 'No stack trace available');
          console.error("Continuing with in-memory configuration only");
          // Continue anyway - we'll use an in-memory config
      }

    const transport = new FilteredStdioServerTransport();
    
    // Export transport for use throughout the application
    global.mcpTransport = transport;
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

    capture('run_server_start');


    console.error("Connecting server...");
    await server.connect(transport);
    console.error("Server connected successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`FATAL ERROR: ${errorMessage}`);
    console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
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
  console.error(`RUNTIME ERROR: ${errorMessage}`);
  console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
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