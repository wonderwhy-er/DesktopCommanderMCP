#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Desktop Commander
 * 
 * This file is used by Smithery CLI to create a Streamable HTTP server.
 * For local stdio usage, see src/index.ts
 * 
 * This is a thin wrapper that:
 * 1. Applies configuration from Smithery
 * 2. Returns the existing MCP server for HTTP transport
 */

import { server } from './server.js';
import { configManager } from './config-manager.js';
import { logToStderr } from './utils/logger.js';

interface ServerConfig {
  config?: {
    allowedDirectories?: string[];
    blockedCommands?: string[];
    defaultShell?: string;
    fileReadLineLimit?: number;
    fileWriteLineLimit?: number;
    telemetryEnabled?: boolean;
  };
}

export default async function createServer({ config }: ServerConfig = {}) {
  logToStderr('info', '🌐 Starting Desktop Commander HTTP Server...');

  // Apply configuration if provided
  if (config) {
    try {
      logToStderr('info', 'Applying HTTP server configuration...');
      
      if (config.allowedDirectories !== undefined) {
        await configManager.setValue('allowedDirectories', config.allowedDirectories);
      }
      if (config.blockedCommands !== undefined) {
        await configManager.setValue('blockedCommands', config.blockedCommands);
      }
      if (config.defaultShell !== undefined) {
        await configManager.setValue('defaultShell', config.defaultShell);
      }
      if (config.fileReadLineLimit !== undefined) {
        await configManager.setValue('fileReadLineLimit', config.fileReadLineLimit);
      }
      if (config.fileWriteLineLimit !== undefined) {
        await configManager.setValue('fileWriteLineLimit', config.fileWriteLineLimit);
      }
      if (config.telemetryEnabled !== undefined) {
        await configManager.setValue('telemetryEnabled', config.telemetryEnabled);
      }
      
      logToStderr('info', '✅ HTTP server configuration applied successfully');
    } catch (error) {
      logToStderr('error', `Failed to apply configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    logToStderr('info', 'No configuration provided, using defaults');
  }

  logToStderr('info', '✅ Desktop Commander HTTP Server ready');
  
  // Return the existing server instance - it already has all tools registered
  return server;
}
