# Cline Notification Problem and Alternative Solutions

## Branch Name Changed
Branch renamed from `explore-stdio-server` to `do-not-show-notification-in-cline`

## The Problem

Desktop Commander currently uses `notifications/message` JSON-RPC method to send log messages:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "desktop-commander",
    "data": "Your log message here"
  }
}
```

**Issue:** Cline displays these notifications in the UI, which creates visual clutter for users.

## Research Findings

### What MCP Specification Says

1. **stdout**: MUST only contain valid JSON-RPC messages
2. **stderr**: Can be used for logging - clients MAY capture, forward, or ignore
3. **notifications/message**: Official MCP logging notification method

### How Different Clients Handle Logging

#### Claude Desktop
- Captures stderr automatically
- Shows `notifications/message` in logs but doesn't overwhelm UI

#### Cline (VSCode Extension)
- **Problem**: Shows `notifications/message` notifications prominently in UI
- **Stderr behavior**: Captures stderr but treats it as error indicator
  - From Issue #1287: "stderr output confuses Roo's MCP server configuration view"
  - From Issue #1959: "Cline spawns MCPs but hides logs that these MCPs may write to the console"
- **Workaround used by others**: `--logLevel none` flag to suppress logging entirely

#### VS Code Copilot
- Has "Show Output" option to view server logs
- Doesn't show notifications in main chat UI

### Key Discovery

From the research, the **only safe logging mechanism** in MCP stdio transport is:

1. **STDERR** - But has limitations:
   - Some clients treat any stderr as error
   - Some clients hide stderr completely
   - Some clients (like Cline) capture it but don't show it well

2. **No alternatives exist** - The MCP spec only defines:
   - Requests (require responses)
   - Responses (must match request)
   - Notifications (one-way messages)

### JSON-RPC 2.0 Notification Types in MCP

According to the spec, these are the **ONLY** notification methods in MCP:

1. **`notifications/message`** - For logging (what we're using now)
2. **`notifications/progress`** - For progress updates
3. **`notifications/initialized`** - Sent after client completes initialization
4. **`notifications/cancelled`** - For cancellation
5. **`notifications/roots/list_changed`** - Root list changed
6. **`notifications/resources/list_changed`** - Resources changed  
7. **`notifications/resources/updated`** - Resource content changed
8. **`notifications/tools/list_changed`** - Tools list changed
9. **`notifications/prompts/list_changed`** - Prompts list changed

**None of these are suitable for silent logging** - they're all meant to be seen by the client.

## Solutions Analysis

### Option 1: Use STDERR Exclusively ❌
**Pros:**
- Standard practice for logging
- Doesn't interfere with JSON-RPC protocol

**Cons:**
- Cline might treat it as errors
- Users can't see logs at all in many clients
- Some MCP servers completely hide stderr
- Inconsistent behavior across clients

### Option 2: Make Logging Configurable ✅ (RECOMMENDED)
**Pros:**
- Users can choose their preference
- Works for all clients
- Most flexible solution

**Cons:**
- Requires configuration management

**Implementation:**
```typescript
interface LoggingConfig {
  enabled: boolean;
  method: 'notifications' | 'stderr' | 'silent';
  level: 'error' | 'warning' | 'info' | 'debug';
}
```

### Option 3: Client Detection ✅ (RECOMMENDED)
**Pros:**
- Automatic - no user configuration needed
- Best experience per client

**Cons:**
- Requires maintaining client detection logic

**Implementation:**
```typescript
// In initialization handler
const clientName = request.params?.clientInfo?.name || 'unknown';

if (clientName === 'vscode-cline' || clientName === 'cline') {
  // Disable notifications/message for Cline
  logConfig.method = 'stderr';
} else if (clientName === 'claude-desktop') {
  // Claude Desktop handles notifications well
  logConfig.method = 'notifications';
}
```

### Option 4: Reduce Notification Volume ✅
**Pros:**
- Simple to implement
- Works with all clients
- Still provides important info

**Cons:**
- Still shows some notifications in Cline

**Implementation:**
- Only send notifications for `error` and `warning` levels
- Use stderr for `info` and `debug`
- Batch startup messages instead of sending individually

### Option 5: Custom Notification Method ❌
**Pros:**
- Could avoid Cline's notification display

**Cons:**
- **Violates MCP spec** - clients expect specific notification methods
- Clients will likely ignore unknown notification methods
- Not a long-term solution

## Recommended Solution

### **Hybrid Approach (Best for Desktop Commander)**

```typescript
class FilteredStdioServerTransport extends StdioServerTransport {
  private logConfig: {
    clientName: string;
    useNotifications: boolean;
    minLevel: 'error' | 'warning' | 'info' | 'debug';
  };

  constructor() {
    super();
    // Default to safe logging
    this.logConfig = {
      clientName: 'unknown',
      useNotifications: false,  // Start with stderr only
      minLevel: 'info'
    };
  }

  public configureLogging(clientInfo: { name: string; version: string }) {
    this.logConfig.clientName = clientInfo.name;
    
    // Client-specific behavior
    if (clientInfo.name === 'claude-desktop') {
      this.logConfig.useNotifications = true;
      this.logConfig.minLevel = 'info';
    } else if (clientInfo.name?.includes('cline') || clientInfo.name?.includes('vscode')) {
      this.logConfig.useNotifications = false;  // Use stderr for Cline
      this.logConfig.minLevel = 'warning';
    } else {
      // For unknown clients, be conservative
      this.logConfig.useNotifications = false;
      this.logConfig.minLevel = 'error';
    }
  }

  private sendLogNotification(level: string, args: any[]) {
    // Check if we should send based on level
    const levelPriority = { debug: 0, info: 1, warning: 2, error: 3 };
    const minPriority = levelPriority[this.logConfig.minLevel];
    const msgPriority = levelPriority[level] || 0;
    
    if (msgPriority < minPriority) {
      return; // Skip this message
    }

    if (this.logConfig.useNotifications) {
      // Send JSON-RPC notification (for Claude Desktop)
      const notification = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level, logger: "desktop-commander", data: /* ... */ }
      };
      this.originalStdoutWrite.call(process.stdout, JSON.stringify(notification) + '\n');
    } else {
      // Send to stderr (for Cline and others)
      const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
    }
  }
}
```

## Implementation Steps

1. **Add client detection** in initialization handler
2. **Configure logging behavior** based on detected client
3. **Reduce notification volume** - only send important messages
4. **Add config option** for users to override (optional)
5. **Document behavior** for different clients

## Alternative: Feature Flag

Add to config.json:
```json
{
  "logging": {
    "enabled": true,
    "useNotifications": false,  // false = stderr only
    "level": "info",
    "clients": {
      "cline": { "useNotifications": false, "level": "warning" },
      "claude-desktop": { "useNotifications": true, "level": "info" }
    }
  }
}
```

## Conclusion

**There is NO way to send invisible logging via JSON-RPC in MCP.** The only options are:

1. ✅ **Use stderr** (standard but has client compatibility issues)
2. ✅ **Client detection** (best automatic solution)
3. ✅ **Reduce notification frequency** (simple and effective)
4. ✅ **Make it configurable** (most flexible)
5. ❌ **Custom notification method** (violates spec)

The best solution is a **combination of #2, #3, and #4**: detect the client, reduce notifications, and allow configuration override.
