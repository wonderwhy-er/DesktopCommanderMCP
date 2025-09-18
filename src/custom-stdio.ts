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
  private isInitialized: boolean = false;
  private messageBuffer: Array<{
    level: "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug";
    args: any[];
    timestamp: number;
  }> = [];

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
    
    // Note: We defer the initialization notification until enableNotifications() is called
    // to ensure MCP protocol compliance - notifications must not be sent before initialization
  }

  /**
   * Call this method after MCP initialization is complete to enable JSON-RPC notifications
   */
  public enableNotifications() {
    this.isInitialized = true;
    
    // Send the deferred initialization notification first
    this.sendLogNotification('info', ['Enhanced FilteredStdioServerTransport initialized']);
    
    // Replay all buffered messages in chronological order
    if (this.messageBuffer.length > 0) {
      this.sendLogNotification('info', [`Replaying ${this.messageBuffer.length} buffered initialization messages`]);
      
      this.messageBuffer
        .sort((a, b) => a.timestamp - b.timestamp)
        .forEach(msg => {
          this.sendLogNotification(msg.level, msg.args);
        });
      
      // Clear the buffer
      this.messageBuffer = [];
    }
    
    this.sendLogNotification('info', ['JSON-RPC notifications enabled']);
  }

  /**
   * Check if notifications are enabled
   */
  public get isNotificationsEnabled(): boolean {
    return this.isInitialized;
  }

  /**
   * Get the current count of buffered messages
   */
  public get bufferedMessageCount(): number {
    return this.messageBuffer.length;
  }

  private setupConsoleRedirection() {
    console.log = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("info", args);
      } else {
        // Buffer for later replay to client
        this.messageBuffer.push({
          level: "info",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.info = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("info", args);
      } else {
        this.messageBuffer.push({
          level: "info",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.warn = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("warning", args);
      } else {
        this.messageBuffer.push({
          level: "warning",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.error = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("error", args);
      } else {
        this.messageBuffer.push({
          level: "error",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.debug = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("debug", args);
      } else {
        this.messageBuffer.push({
          level: "debug",
          args,
          timestamp: Date.now()
        });
      }
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
          if (this.isInitialized) {
            this.sendLogNotification("info", [buffer.replace(/\n$/, '')]);
          } else {
            // Buffer for later replay to client
            this.messageBuffer.push({
              level: "info",
              args: [buffer.replace(/\n$/, '')],
              timestamp: Date.now()
            });
          }
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
      // Fallback to a simple JSON-RPC error notification if JSON serialization fails
      const fallbackNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: "error",
          logger: "desktop-commander",
          data: `Log serialization failed: ${args.join(' ')}`
        }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
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
      // Fallback to basic JSON-RPC notification
      const fallbackNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: "error",
          logger: "desktop-commander",
          data: `sendLog failed: ${message}`
        }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
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
      // Fallback to basic JSON-RPC notification for progress
      const fallbackNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: "info",
          logger: "desktop-commander",
          data: `Progress ${token}: ${value}${total ? `/${total}` : ''}`
        }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
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
      // Fallback to basic JSON-RPC notification for custom notifications
      const fallbackNotification = {
        jsonrpc: "2.0" as const,
        method: "notifications/message",
        params: {
          level: "error",
          logger: "desktop-commander",
          data: `Custom notification failed: ${method}: ${JSON.stringify(params)}`
        }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(fallbackNotification) + '\n');
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
