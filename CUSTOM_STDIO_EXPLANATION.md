# Custom Stdio Server - How It Works

## Overview
Desktop Commander uses a custom stdio transport layer that wraps standard console output (console.log, console.error, etc.) and raw stdout writes into valid JSON-RPC notification messages. This prevents crashes in MCP clients that expect all stdio communication to be JSON-RPC formatted.

## File Locations

### 1. Custom Transport Implementation
**File:** `src/custom-stdio.ts`

This file contains the `FilteredStdioServerTransport` class that extends the standard MCP SDK's `StdioServerTransport`.

### 2. Server Integration
**File:** `src/index.ts`

This is where the custom transport is instantiated and connected to the MCP server.

## How It Works

### Architecture Flow

```
Application Code
    ↓
console.log() / process.stdout.write()
    ↓
FilteredStdioServerTransport (intercepts)
    ↓
Wraps in JSON-RPC notification format
    ↓
Original stdout (valid JSON-RPC only)
    ↓
MCP Client (Claude Desktop, etc.)
```

## Key Components

### 1. Console Redirection (`setupConsoleRedirection()`)

Located in `src/custom-stdio.ts`, this method intercepts all console methods:

```typescript
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
```

**What happens:**
- All `console.log()`, `console.warn()`, `console.error()`, etc. calls are intercepted
- Before initialization: Messages are buffered in memory
- After initialization: Messages are converted to JSON-RPC notifications
- Original console methods are stored and can be restored

### 2. Stdout Filtering (`setupStdoutFiltering()`)

Also in `src/custom-stdio.ts`, this method intercepts raw writes to stdout:

```typescript
process.stdout.write = (buffer: any, encoding?: any, callback?: any): boolean => {
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
  
  return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
};
```

**What happens:**
- Intercepts ALL writes to `process.stdout.write()`
- Checks if content is already valid JSON-RPC (looks for `"jsonrpc"`, `"method"`, `"id"`)
- If valid JSON-RPC → passes through unchanged
- If plain text → wraps in JSON-RPC notification
- If before initialization → buffers for later

### 3. JSON-RPC Notification Format (`sendLogNotification()`)

Messages are wrapped in the MCP logging notification format:

```typescript
const notification: LogNotification = {
  jsonrpc: "2.0",
  method: "notifications/message",
  params: {
    level: level,  // "info", "warning", "error", "debug", etc.
    logger: "desktop-commander",
    data: data     // The actual message content
  }
};
```

**Result:** Every log message becomes a proper MCP notification that clients can handle safely.

### 4. Initialization Flow


The initialization happens in `src/index.ts`:

```typescript
// In src/index.ts
async function runServer() {
  // ... config loading ...
  
  const transport = new FilteredStdioServerTransport();
  
  // Export transport for global access
  global.mcpTransport = transport;
  
  // Set up event-driven initialization completion handler
  server.oninitialized = () => {
    // CRITICAL: This is called AFTER MCP handshake is complete
    transport.enableNotifications();
    
    // Flush all deferred messages
    while (deferredMessages.length > 0) {
      const msg = deferredMessages.shift()!;
      transport.sendLog('info', msg.message);
    }
    flushDeferredMessages();
    
    transport.sendLog('info', 'Server connected successfully');
  };

  await server.connect(transport);
}
```

**Initialization sequence:**

1. **Transport created** → Console/stdout interception begins immediately
2. **Messages buffered** → Any logs before initialization are stored in memory
3. **MCP handshake** → Client and server negotiate protocol version/capabilities
4. **`server.oninitialized` fires** → This is when the handshake completes
5. **`enableNotifications()` called** → Sets `isInitialized = true`
6. **Buffered messages replayed** → All startup logs are sent in chronological order
7. **Normal operation** → Future logs are sent immediately as JSON-RPC notifications

### Why This Matters

**Without buffering:**
- Logs sent during initialization would violate MCP protocol
- Client might crash or reject the connection
- Startup messages would be lost

**With buffering:**
- All messages are preserved
- Protocol compliance is maintained
- Clients receive complete startup history

## Key Methods

### Public API Methods

The `FilteredStdioServerTransport` class exposes several useful methods:

```typescript
// Enable notifications after initialization
public enableNotifications(): void

// Send a log notification (any time after initialization)
public sendLog(
  level: "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug",
  message: string,
  data?: any
): void

// Send progress updates for long operations
public sendProgress(token: string, value: number, total?: number): void

// Send custom notifications
public sendCustomNotification(method: string, params: any): void

// Cleanup and restore original console/stdout
public cleanup(): void

// Check if notifications are enabled
public get isNotificationsEnabled(): boolean

// Get count of buffered messages
public get bufferedMessageCount(): number
```

## Usage Examples

### Example 1: Using Console Methods Anywhere

```typescript
// In any file in the application
console.log("This will become a JSON-RPC notification");
console.warn("Warning message");
console.error("Error occurred", { details: "some data" });
```

All of these are automatically wrapped and sent as proper MCP notifications.

### Example 2: Direct Logging via Transport

```typescript
// Access the global transport
const transport = global.mcpTransport;

// Send structured logs
transport.sendLog('info', 'Processing started', {
  fileCount: 42,
  status: 'active'
});
```

### Example 3: Progress Notifications

```typescript
// For long-running operations
const transport = global.mcpTransport;

for (let i = 0; i < 100; i++) {
  transport.sendProgress('task-123', i, 100);
  // ... do work ...
}
transport.sendProgress('task-123', 100, 100); // Complete
```

## Benefits

1. **Protocol Compliance** - All stdout is valid JSON-RPC
2. **No Lost Messages** - Buffering preserves startup logs
3. **Developer Experience** - Use normal console.log() anywhere
4. **Flexibility** - Can send structured data or simple strings
5. **Error Prevention** - Prevents client crashes from malformed output

## Technical Details

### Message Buffer Structure

```typescript
private messageBuffer: Array<{
  level: "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug";
  args: any[];
  timestamp: number;
}> = [];
```

Messages are timestamped and sorted chronologically before replay.

### Original References Preserved

```typescript
private originalConsole: {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  info: typeof console.info;
};

private originalStdoutWrite: typeof process.stdout.write;
```

This allows cleanup/restoration if needed and enables calling original methods for JSON-RPC output.

## Summary

The custom stdio server works by:
1. **Intercepting** all console methods and stdout writes at startup
2. **Buffering** messages until MCP initialization completes
3. **Wrapping** all output in valid JSON-RPC notification format
4. **Replaying** buffered messages after initialization
5. **Forwarding** all future logs as proper notifications

This ensures Desktop Commander maintains full MCP protocol compliance while still allowing normal console logging throughout the codebase.
