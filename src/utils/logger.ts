/**
 * Centralized logging utility for Desktop Commander
 * Ensures all logging goes through proper channels based on initialization state
 */

import type { FilteredStdioServerTransport } from '../custom-stdio.js';

// Global reference to the MCP transport (set in index.ts)
declare global {
  var mcpTransport: FilteredStdioServerTransport | undefined;
}

export type LogLevel = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug';

/**
 * Log a message using the appropriate method based on MCP initialization state
 */
export function log(level: LogLevel, message: string, data?: any): void {
  try {
    // Check if MCP transport is available
    if (global.mcpTransport) {
      // Always use MCP logging (will buffer if not initialized yet)
      global.mcpTransport.sendLog(level, message, data);
    } else {
      // This should rarely happen, but fallback to create a JSON-RPC notification manually
      const notification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: level,
          logger: "desktop-commander",
          data: data ? { message, ...data } : message
        }
      };
      process.stdout.write(JSON.stringify(notification) + '\n');
    }
  } catch (error) {
    // Ultimate fallback - but this should be JSON-RPC too
    const notification = {
      jsonrpc: "2.0" as const,
      method: "notifications/message", 
      params: {
        level: "error",
        logger: "desktop-commander",
        data: `[LOG-ERROR] Failed to log message: ${message}`
      }
    };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }
}

/**
 * Convenience functions for different log levels
 */
export const logger = {
  emergency: (message: string, data?: any) => log('emergency', message, data),
  alert: (message: string, data?: any) => log('alert', message, data),
  critical: (message: string, data?: any) => log('critical', message, data),
  error: (message: string, data?: any) => log('error', message, data),
  warning: (message: string, data?: any) => log('warning', message, data),
  notice: (message: string, data?: any) => log('notice', message, data),
  info: (message: string, data?: any) => log('info', message, data),
  debug: (message: string, data?: any) => log('debug', message, data),
};

/**
 * Log to stderr during early initialization (before MCP is ready)
 * Use this for critical startup messages that must be visible
 * NOTE: This should also be JSON-RPC format
 */
export function logToStderr(level: LogLevel, message: string): void {
  const notification = {
    jsonrpc: "2.0" as const,
    method: "notifications/message",
    params: {
      level: level,
      logger: "desktop-commander", 
      data: message
    }
  };
  process.stdout.write(JSON.stringify(notification) + '\n');
}
