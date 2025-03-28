#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server, DesktopCommanderServer, type Mode, type Permission } from './server.js';
import { commandManager } from './command-manager.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Argument Parsing ---
function parseArgs(): { mode: Mode, permission: Permission } {
  let mode: Mode = 'granular'; // Default mode
  let permission: Permission = 'all'; // Default permission

  for (const arg of process.argv.slice(2)) { // Skip node path and script path
    if (arg === 'setup') {
      continue; // Skip the setup argument
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.split('=')[1];
      if (['granular', 'grouped', 'unified'].includes(value)) {
        mode = value as Mode;
      } else {
        console.error(`Warning: Invalid --mode value '${value}'. Using default '${mode}'.`);
      }
    } else if (arg.startsWith('--permission=')) {
      const value = arg.split('=')[1];
      if (['readOnly', 'readWrite', 'execute', 'all', 'none'].includes(value)) {
        permission = value as Permission;
      } else {
        console.error(`Warning: Invalid --permission value '${value}'. Using default '${permission}'.`);
      }
    }
  }
  return { mode, permission };
}
// --- End Argument Parsing ---

async function runSetup() {
  const setupScript = join(__dirname, 'setup-claude-server.js');
  const { default: setupModule } = await import(setupScript);
  if (typeof setupModule === 'function') {
    await setupModule();
  }
}

async function runServer() {
  try {
    // Check if first argument is "setup"
    if (process.argv[2] === 'setup') {
      await runSetup();
      return;
    }

    // --- Parse CLI args and configure server ---
    const { mode, permission } = parseArgs();
    // Check if server is an instance of DesktopCommanderServer before calling setters
    if (server instanceof DesktopCommanderServer) {
      server.setMode(mode);
      server.setPermission(permission);
    } else {
      console.error("Error: Server instance is not of type DesktopCommanderServer. Cannot set mode/permission.");
    }
    // --- End Configuration ---

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Uncaught Exception: ${errorMessage}`); // Log to stderr
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', async (reason) => {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      console.error(`Unhandled Rejection: ${errorMessage}`); // Log to stderr
      process.exit(1);
    });

    const transport = new StdioServerTransport();

    // Load blocked commands from config file
    await commandManager.loadBlockedCommands();

    await server.connect(transport);
    console.error("DesktopCommander MCP Server Connected"); // Log connection to stderr
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(JSON.stringify({
      type: 'error',
      timestamp: new Date().toISOString(),
      message: `Failed to start server: ${errorMessage}`
    }) + '\n');
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
  process.exit(1);
});