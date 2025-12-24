# 🚀 Remote MCP Quick Start Guide

**Control remote machines through Claude Desktop in 5 minutes!**

## Architecture
```
Claude Desktop → Remote MCP Server → Local Agent → Target Machine
```

## Steps

### 1. Start Remote MCP Server
```bash
cd remote-mcp-server
npm install && npm run build && npm run dev
# Server runs on http://localhost:3002
```

### 2. Get Device Token
```bash
# Option A: Web dashboard
open http://localhost:3002
# Login: test@example.com / Test User
# Register device and copy token

# Option B: Command line
node get-device-token.js --email your@email.com --name "Your Name" --device "Your Computer"
```

### 3. Start Local Agent (on target machine)
```bash
./agent.js http://localhost:3002 "YOUR_DEVICE_TOKEN"
# Should show: ✅ SSE connection established
```

### 4. Connect Claude Desktop (Choose Method)

#### **Method A: Direct MCP (Recommended)**

1. **Find Claude config directory:**
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

3. **Restart Claude Desktop**

#### **Method B: Via Desktop Commander**
```bash
cd /Users/dasein/dev/DC/DesktopCommanderMCP
npm run setup
# Restart Claude Desktop completely
```

### 5. Use Remote Commands

#### **With Method A (Direct MCP):**
```
connect_remote server_url: http://localhost:3002 device_token: YOUR_TOKEN
remote_execute method: read_file params: {"path": "/etc/hosts"}
remote_status
```

#### **With Method B (Desktop Commander):**
```
Please connect to my remote MCP server using:
- Server URL: http://localhost:3002
- Device Token: YOUR_DEVICE_TOKEN_HERE

Read the file /etc/hosts on the remote machine
```

## Troubleshooting

**❌ mcp-remote error?** 
- DON'T use `npx mcp-remote` - that's a different tool
- Use Method A (Direct MCP) or Method B (Desktop Commander)

**❌ Connection failed?**
- Check server is running: `curl http://localhost:3002/health`
- Verify agent shows "Connected to Remote MCP Server"
- Check Claude config path is correct

**❌ Device offline?**
- Restart the local agent
- Check dashboard: http://localhost:3002

---
**📖 Full documentation:** `/remote-mcp-server/README.md`