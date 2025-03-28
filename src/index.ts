#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server, DesktopCommanderServer, type Mode, type Permission, type PermissionPreset, ToolCategories } from './server.js';
import { commandManager } from './command-manager.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Argument Parsing ---
function parseArgs(): { mode: Mode, permission: Permission, blockedCommands: string[] } {
  let mode: Mode = 'granular'; // Default mode
  let permission: Permission = 'all'; // Default permission
  let blockedCommands: string[] = []; // Default: no blocked commands

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
    } else if (arg.startsWith('--auth=')) {
      // Extract the value after the equal sign
      const paramName = '--auth';
      const value = arg.split('=')[1];

      // Validate the permission string
      if (value) {
        // Check if it's a preset
        const presets: PermissionPreset[] = ['read', 'write', 'execute', 'all', 'none'];

        if (presets.includes(value as PermissionPreset)) {
          permission = value;
        } else {
          // Otherwise validate as a comma-separated list
          const parts = value.split(',').map(p => p.trim().toLowerCase());

          // Get a list of all tool names (lowercase)
          const allToolNames = Object.keys(ToolCategories).map(name => name.toLowerCase());

          // Simple validation - each part should be a valid permission part
          const validParts = [...presets, '-read', '-write', '-execute'];
          const allPartsValid = parts.every(part => {
            // Check if it's a standard permission or negation
            if (validParts.includes(part) ||
                (part.startsWith('-') && validParts.includes(part.substring(1)))) {
              return true;
            }

            // Check if it's a specific tool name or negation of a tool
            if (allToolNames.includes(part) ||
                (part.startsWith('-') && allToolNames.includes(part.substring(1)))) {
              return true;
            }

            return false;
          });

          if (allPartsValid) {
            permission = value;
          } else {
            console.error(`Warning: Invalid ${paramName} value '${value}'. Using default '${permission}'.`);
          }
        }
      } else {
        console.error(`Warning: Empty ${paramName} value. Using default '${permission}'.`);
      }
    } else if (arg.startsWith('--block=')) {
      // Extract the value after --block=
      const value = arg.split('=')[1];

      if (value) {
        // Parse comma-separated list of commands to block
        blockedCommands = value.split(',')
          .map(cmd => cmd.trim())
          .filter(cmd => cmd.length > 0);
      } else {
        console.error(`Warning: Empty --block value. No commands will be blocked by default.`);
      }
    }
  }
  return { mode, permission, blockedCommands };
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
    const { mode, permission, blockedCommands } = parseArgs();
    // Check if server is an instance of DesktopCommanderServer before calling setters
    if (server instanceof DesktopCommanderServer) {
      server.setMode(mode);
      server.setPermission(permission);
    } else {
      console.error("Error: Server instance is not of type DesktopCommanderServer. Cannot set mode/permission.");
    }
    // --- End Configuration ---

    // Load blocked commands from config file
    await commandManager.loadBlockedCommands();

    // Add commands from command line argument to the blocked commands
    // This way we get the union of config file commands and command line args
    for (const cmd of blockedCommands) {
      // Only need to call blockCommand if it's not already blocked
      // This will prevent unnecessary writes to the config file
      if (!commandManager.listBlockedCommands().includes(cmd)) {
        await commandManager.blockCommand(cmd);
      }
    }

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