# Testing Custom Notification Method "log/info"

## What We Changed

Modified `src/custom-stdio.ts` to use a **custom JSON-RPC notification method** called `log/info` instead of the standard `notifications/message`.

### Before:
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "desktop-commander",
    "data": "Your log message"
  }
}
```

### After (EXPERIMENTAL):
```json
{
  "jsonrpc": "2.0",
  "method": "log/info",
  "params": {
    "level": "info",
    "logger": "desktop-commander",
    "data": "Your log message"
  }
}
```

## Hypothesis

According to JSON-RPC 2.0 spec, clients should **silently ignore** notification methods they don't recognize. If this works:
- ✅ Claude Desktop should ignore these and not crash
- ✅ Cline should ignore these and not display them in UI
- ✅ MCP protocol will still work normally for requests/responses

## How to Test

### 1. Test in Current Chat (Claude Desktop)

You're currently using Claude Desktop. The code is already built. Let's test it:

**Step 1:** Restart the Desktop Commander server
```bash
# Kill any running DC processes
pkill -f "desktop-commander"

# Check if it's still running
ps aux | grep desktop-commander
```

**Step 2:** Run a simple DC command and check if:
- The command works normally
- No errors appear
- Startup messages are NOT visible (if they were before)

### 2. Test in Cline

**Configuration:**
1. Open VSCode with Cline extension
2. Configure Desktop Commander in Cline's MCP settings:
```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "node",
      "args": [
        "/Users/eduardsruzga/work/DesktopCommanderMCP/dist/index.js"
      ],
      "disabled": false
    }
  }
}
```

**Test Steps:**
1. Start Cline and connect to Desktop Commander
2. Run a simple DC command (like `list_directory`)
3. **Check if notifications appear in Cline's UI**

### Expected Results

| Client | Expected Behavior |
|--------|------------------|
| Claude Desktop | Should work normally, logs might be invisible |
| Cline | Should NOT show notification popups |
| MCP Inspector | Should work, might show unknown method warning |

## Potential Outcomes

### ✅ Success: Clients Ignore Unknown Notifications
- Commands work normally
- No crashes or errors
- Cline doesn't show notifications
- **This would be the best solution!**

### ⚠️ Warning: Clients Log Unknown Methods
- Commands work
- Clients log warnings like "Unknown notification method: log/info"
- But still functional
- **Still acceptable**

### ❌ Failure: Clients Reject Unknown Methods
- Connection fails or crashes
- Errors like "Invalid notification method"
- Server stops working
- **Need to revert changes**

## Rollback Plan

If this fails, revert by changing line in `src/custom-stdio.ts`:

```typescript
// Change FROM:
method: "log/info",

// Change TO:
method: "notifications/message",
```

Then rebuild:
```bash
npm run build
```

## Alternative Custom Methods to Try

If `log/info` doesn't work well, we could try:

1. `server/log` - Looks more "internal"
2. `notifications/custom` - Closer to spec
3. `mcp/log` - MCP-prefixed
4. `x-log/info` - Vendor extension style (like HTTP headers)

## Test Commands

Simple commands to test Desktop Commander is working:

```bash
# Test in terminal (if using stdio)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js

# In Claude/Cline, try:
# "Use Desktop Commander to list files in the current directory"
```

## Monitoring

Watch for these in logs:
- Startup messages about "Enhanced FilteredStdioServerTransport initialized"
- Any error messages about invalid methods
- Whether clients crash or continue working

## Next Steps

After testing, document results here:

### Test Results:

**Claude Desktop:**
- [ ] Commands work normally
- [ ] No errors
- [ ] Notifications visible/invisible?

**Cline:**
- [ ] Commands work normally  
- [ ] Notifications appear in UI? (Yes/No)
- [ ] Any errors or warnings?

**Other Observations:**
- 

---

## Code Changes Made

1. Added `sendCustomLog()` method to `FilteredStdioServerTransport` class
2. Modified `sendLogNotification()` to use `"log/info"` instead of `"notifications/message"`
3. Changed fallback from JSON-RPC notification to stderr write

**Files modified:**
- `src/custom-stdio.ts`

**Commit:**
```bash
git add src/custom-stdio.ts
git commit -m "EXPERIMENTAL: Test custom log/info notification method"
```
