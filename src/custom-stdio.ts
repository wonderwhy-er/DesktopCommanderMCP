import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import process from "node:process";

interface LogNotification {
  jsonrpc: "2.0";
  method: "notifications/message";
  params: {
    level: "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug";
    logger?: string;
    data: any;
  };
}

/**
 * Enhanced StdioServerTransport that wraps console output in valid JSON-RPC structures
 * instead of filtering them out. This prevents crashes while maintaining debug visibility.
 */
export class FilteredStdioServerTransport extends StdioServerTransport {
  private originalConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
    info: typeof console.info;
  };
  private originalStdoutWrite: typeof process.stdout.write;

  constructor() {
    super();
    
    // Store original methods
    this.originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
      info: console.info,
    };
    
    this.originalStdoutWrite = process.stdout.write;
    
    // Setup console redirection
    this.setupConsoleRedirection();
    
    // Setup stdout filtering for any other output
    this.setupStdoutFiltering();
    
    // Log initialization to stderr to avoid polluting the JSON stream
    process.stderr.write(`[desktop-commander] Enhanced FilteredStdioServerTransport initialized\n`);
  }

  private setupConsoleRedirection() {
    console.log = (...args: any[]) => {
      this.sendLogNotification("info", args);
    };

    console.info = (...args: any[]) => {
      this.sendLogNotification("info", args);
    };

    console.warn = (...args: any[]) => {
      this.sendLogNotification("warning", args);
    };

    console.error = (...args: any[]) => {
      this.sendLogNotification("error", args);
    };

    console.debug = (...args: any[]) => {
      this.sendLogNotification("debug", args);
    };
  }

  private setupStdoutFiltering() {
    process.stdout.write = (buffer: any, encoding?: any, callback?: any): boolean => {
      // Handle different call signatures
      if (typeof buffer === 'string') {
        const trimmed = buffer.trim();
        
        // Check if this looks like a valid JSON-RPC message
        if (trimmed.startsWith('{') && (
          trimmed.includes('"jsonrpc"') || 
          trimmed.includes('"method"') || 
          trimmed.includes('"id"')
        )) {
          // This looks like a valid JSON-RPC message, allow it
          return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
        } else if (trimmed.length > 0) {
          // Non-JSON-RPC output, wrap it in a log notification
          this.sendLogNotification("info", [buffer.replace(/\n$/, '')]);
          if (callback) callback();
          return true;
        }
      }
      
      // For non-string buffers or empty strings, let them through
      return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
    };
  }

  private sendLogNotification(level: "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug", args: any[]) {
    try {
      // For data, we can send structured data or string according to MCP spec
      let data: any;
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        // Single object - send as structured data
        data = args[0];
      } else {
        // Multiple args or primitives - convert to string
        data = args.map(arg => {
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg, null, 2);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        }).join(' ');
      }

      const notification: LogNotification = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: level,
          logger: "desktop-commander",
          data: data
        }
      };

      // Send as valid JSON-RPC notification
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } catch (error) {
      // Fallback to stderr if JSON serialization fails
      process.stderr.write(`[${level.toUpperCase()}] ${args.join(' ')}\n`);
    }
  }

  /**
   * Public method to send log notifications from anywhere in the application
   */
  public sendLog(level: "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug", message: string, data?: any) {
    try {
      const notification: LogNotification = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: level,
          logger: "desktop-commander",
          data: data ? { message, ...data } : message
        }
      };

      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } catch (error) {
      process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
    }
  }

  /**
   * Send a progress notification (useful for long-running operations)
   */
  public sendProgress(token: string, value: number, total?: number) {
    try {
      const notification = {
        jsonrpc: "2.0" as const,
        method: "notifications/progress",
        params: {
          progressToken: token,
          value: value,
          ...(total && { total })
        }
      };
      
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } catch (error) {
      process.stderr.write(`[PROGRESS] ${token}: ${value}${total ? `/${total}` : ''}\n`);
    }
  }

  /**
   * Send a custom notification with any method name
   */
  public sendCustomNotification(method: string, params: any) {
    try {
      const notification = {
        jsonrpc: "2.0" as const,
        method: method,
        params: params
      };
      
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } catch (error) {
      process.stderr.write(`[NOTIFICATION] ${method}: ${JSON.stringify(params)}\n`);
    }
  }

  /**
   * Cleanup method to restore original console methods if needed
   */
  public cleanup() {
    if (this.originalConsole) {
      console.log = this.originalConsole.log;
      console.warn = this.originalConsole.warn;
      console.error = this.originalConsole.error;
      console.debug = this.originalConsole.debug;
      console.info = this.originalConsole.info;
    }
    
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
    }
  }
}
