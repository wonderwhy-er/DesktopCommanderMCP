# Remote MCP Server via SSE

🚀 **Remote Machine Control through Claude Desktop using Server-Sent Events**

This system enables you to control remote machines through Claude Desktop using Desktop Commander MCP tools and SSE (Server-Sent Events) for real-time communication.

## 🏗 Architecture Overview

```
Claude Desktop (Desktop Commander)
    ↕️ HTTP API calls
Remote MCP Server (localhost:3002)
    ↕️ SSE connection  
Local Agent (runs on target machine)
    ↕️ File system & process execution
```

## 🎯 Quick Start Guide

### Step 1: Start the Remote MCP Server

```bash
cd remote-mcp-server
npm install
npm run build
npm run dev
```

Server will start on: **http://localhost:3002**

### Step 2: Get Your Device Token

**Option A: Via Web Dashboard**
1. Open http://localhost:3002 in browser
2. Login with:
   - Email: `test@example.com`
   - Name: `Test User`
3. Register device with name: `My Remote Computer`  
4. **Copy the device token** from popup (starts with `eyJhbGci...`)

**Option B: Via Command Line**
```bash
node get-device-token.js --email your@email.com --name "Your Name" --device "Your Computer"
```

### Step 3: Start Local Agent on Target Machine

On the machine you want to control remotely:

```bash
cd remote-mcp-server
./agent.js http://localhost:3002 "YOUR_DEVICE_TOKEN_HERE"
```

Expected output:
```
🚀 Starting Local MCP Agent...
📡 Connecting to SSE endpoint: http://localhost:3002/sse?deviceToken=...
✅ SSE connection established
🎉 Connected to Remote MCP Server
📱 Device ID: abc123-def456
```

### Step 4: Connect Claude Desktop (Choose Option A or B)

#### **Option A: Direct MCP Server (Recommended)**

1. **Find your Claude Desktop config directory:**
   - **macOS**: `~/Library/Application Support/Claude/`
   - **Windows**: `%APPDATA%\Claude\`
   - **Linux**: `~/.config/Claude/`

2. **Edit `claude_desktop_config.json`:**
   ```json
   {
     "mcpServers": {
       "remote-mcp": {
         "command": "node",
         "args": ["/Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server/mcp-server.js"],
         "env": {}
       }
     }
   }
   ```

   **Update the path** to match your actual installation directory.

3. **Restart Claude Desktop** completely (quit and reopen).

#### **Option B: Via Desktop Commander**

```bash
cd /Users/dasein/dev/DC/DesktopCommanderMCP
npm install
npm run build
npm run setup
```

**Restart Claude Desktop** completely (quit and reopen).

### Step 5: Connect and Use (Based on Option)

#### **If using Option A (Direct MCP):**

1. **Connect to remote server:**
   ```
   connect_remote server_url: http://localhost:3002 device_token: YOUR_DEVICE_TOKEN_HERE
   ```

2. **Execute commands:**
   ```
   remote_execute method: read_file params: {"path": "/etc/hosts"}
   ```

3. **Check status:**
   ```
   remote_status
   ```

#### **If using Option B (Desktop Commander):**

Send this message:
```
Please connect to my remote MCP server using:
- Server URL: http://localhost:3002  
- Device Token: YOUR_DEVICE_TOKEN_HERE
```

## 🎮 Using Remote Commands

### With Option A (Direct MCP Server)

Use the MCP tools directly in Claude Desktop:

**Connect to your remote server:**
```
connect_remote
server_url: http://localhost:3002
device_token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Read remote files:**
```
remote_execute
method: read_file
params: {"path": "/etc/hosts"}
```

**Execute remote commands:**
```
remote_execute
method: start_process
params: {"command": "uname -a"}
```

**List directories:**
```
remote_execute
method: list_directory  
params: {"path": "/home"}
```

**Create files:**
```
remote_execute
method: write_file
params: {"path": "/tmp/test.txt", "content": "Hello from Remote MCP"}
```

**Check connection status:**
```
remote_status
```

### With Option B (Desktop Commander)

Use natural language after connecting:

```
Please connect to my remote MCP server using:
- Server URL: http://localhost:3002  
- Device Token: YOUR_DEVICE_TOKEN_HERE
```

Then use natural language:
```
Read the file /etc/hosts on the remote machine
Run the command "uname -a" on the remote machine
Show me the contents of the /home directory on the remote machine
Create a file called test.txt with content "Hello from Remote MCP" on the remote machine
```

## 🔧 Example Complete Workflow

### 1. Get Device Token (Command Line)
```bash
node get-device-token.js --email john@example.com --name "John Doe" --device "Production Server"
```
Output:
```
🎉 SUCCESS! Your device token is ready to use.
🔑 YOUR DEVICE TOKEN:
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6IjViMmQ5MWI3LWIyNGYtNDU4OS1hOTJlLWI4YTM3YmVkZTNjYSIsInVzZXJJZCI6IjM1NTI4NzYxLWY4MDYtNDcwYi1iNzQ4LTFmN2E2NDU0MDQzMiIsInR5cGUiOiJkZXZpY2UiLCJpYXQiOjE3NjY1NDQ2MzgsImV4cCI6MTc2OTEzNjYzOH0.7Hu1SIkvRXA9TLS0AUBVDUvicvIzaNrnRc9ngfQL9Ck
```

### 2. Start Local Agent
```bash
./agent.js http://localhost:3002 "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6IjViMmQ5MWI3LWIyNGYtNDU4OS1hOTJlLWI4YTM3YmVkZTNjYSIsInVzZXJJZCI6IjM1NTI4NzYxLWY4MDYtNDcwYi1iNzQ4LTFmN2E2NDU0MDQzMiIsInR5cGUiOiJkZXZpY2UiLCJpYXQiOjE3NjY1NDQ2MzgsImV4cCI6MTc2OTEzNjYzOH0.7Hu1SIkvRXA9TLS0AUBVDUvicvIzaNrnRc9ngfQL9Ck"
```

### 3. Connect in Claude Desktop
```
Please connect to my remote MCP server using:
- Server URL: http://localhost:3002
- Device Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6IjViMmQ5MWI3LWIyNGYtNDU4OS1hOTJlLWI4YTM3YmVkZTNjYSIsInVzZXJJZCI6IjM1NTI4NzYxLWY4MDYtNDcwYi1iNzQ4LTFmN2E2NDU0MDQzMiIsInR5cGUiOiJkZXZpY2UiLCJpYXQiOjE3NjY1NDQ2MzgsImV4cCI6MTc2OTEzNjYzOH0.7Hu1SIkvRXA9TLS0AUBVDUvicvIzaNrnRc9ngfQL9Ck
```

### 4. Test Commands
```
Check my remote MCP connection status
```

```
Read the file /etc/hosts on the remote machine
```

```
Run the command "ls -la" on the remote machine
```

## 🔍 Verification & Troubleshooting

### Check Connection Status
```bash
# Server health
curl http://localhost:3002/health

# SSE connections
curl http://localhost:3002/sse/status

# Dashboard
open http://localhost:3002
```

### Common Issues

**❌ "Failed to connect to Remote MCP Server"**
- Ensure Remote MCP Server is running on port 3002
- Check device token is copied correctly (no extra spaces)
- Verify local agent is connected and shows "Connected to Remote MCP Server"

**❌ "Device is offline or not connected"**  
- Restart the local agent
- Check that device shows "ONLINE" in dashboard
- Ensure device token hasn't expired

**❌ "Access token required"**
- Make sure you're using the device token (not user token) 
- Check that Desktop Commander is properly built and setup

**❌ DON'T USE `mcp-remote` package!**
- This implementation uses **Desktop Commander MCP tools**, not the `mcp-remote` package
- Do NOT run `npx mcp-remote` - it's a different system
- Follow the **Step 4 & 5** instructions above to connect via Desktop Commander

## 🧪 Testing & Development

### Test SSE Connection
```bash
node test-sse.js http://localhost:3002 "YOUR_DEVICE_TOKEN"
```

### Direct API Testing
```bash
curl -X POST http://localhost:3002/api/mcp/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_DEVICE_TOKEN" \
  -d '{
    "jsonrpc": "2.0", 
    "id": 1,
    "method": "read_file",
    "params": {"path": "/etc/hosts"}
  }'
```

### Health Monitoring  
```bash
# Server status
curl http://localhost:3002/health
# Returns: {"status":"healthy","connections":0,"sseConnections":1,"pendingRequests":0}

# SSE status  
curl http://localhost:3002/sse/status
# Returns: {"connectionCount":1,"connectedDevices":["device-id"],"timestamp":"..."}
```

## 🛡 Security Notes

- Device tokens expire after 30 days
- Only one device per user is allowed
- Use HTTPS in production
- Store device tokens securely
- Monitor for suspicious activity

## 📁 Project Structure

```
remote-mcp-server/
├── agent.js              # Local agent executable
├── get-device-token.js   # Token generation helper
├── test-sse.js          # SSE connection tester
├── src/
│   ├── server.ts        # Main Express server  
│   ├── sse/             # SSE implementation
│   ├── auth/            # JWT authentication
│   ├── database/        # PostgreSQL models
│   └── types.ts         # TypeScript definitions
└── public/              # Web dashboard
```

## 🎯 Supported MCP Methods

- `read_file` - Read file contents with offset/length
- `write_file` - Write/append to files
- `list_directory` - List directory contents
- `create_directory` - Create directories recursively  
- `move_file` - Move/rename files and directories
- `get_file_info` - Get file metadata and stats
- `start_process` - Execute shell commands with timeout
- `interact_with_process` - Send input to running processes
- `read_process_output` - Read process output
- `force_terminate` - Terminate processes
- `list_sessions` - List active sessions
- `start_search` - Start file search
- `get_more_search_results` - Get additional search results
- `stop_search` - Stop active search
- `edit_block` - Edit file blocks

---

**🚀 The Remote MCP Server is now ready for production use with Claude Desktop!**