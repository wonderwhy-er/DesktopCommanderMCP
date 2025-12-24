# Remote MCP Setup Guide

## 🌟 Overview

Remote MCP allows you to control remote machines through Claude Desktop using the Desktop Commander MCP server. This enables you to execute file operations, run commands, and manage remote systems directly from your Claude Desktop interface.

## 📋 Prerequisites

- Node.js 18+ installed
- PostgreSQL database running
- Desktop Commander MCP installed and configured
- Remote machine with network access

## 🚀 Quick Setup

### Step 1: Start the Remote MCP Server

1. **Navigate to the remote-mcp-server directory:**
   ```bash
   cd /Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables (.env file):**
   ```bash
   # Database
   POSTGRES_URL="postgresql://dasein@localhost:5432/dc_app_dev3_tmp"

   # JWT Secret (change in production)
   JWT_SECRET="your-secret-key-change-in-production-make-it-long-and-random"

   # Server
   PORT=3002
   NODE_ENV=development

   # OAuth (placeholder for future integration)
   GOOGLE_CLIENT_ID=""
   GOOGLE_CLIENT_SECRET=""
   OAUTH_REDIRECT_URI="http://localhost:3002/auth/callback"
   ```

4. **Start the server:**
   ```bash
   npm run dev
   ```

   You should see:
   ```
   🚀 Remote MCP Server running on port 3002
   📊 Dashboard: http://localhost:3002
   🔌 WebSocket: ws://localhost:3002/ws
   💾 Database: localhost:5432/dc_app_dev3_tmp
   ```

### Step 2: Register Your Remote Device

1. **Open the web dashboard:**
   - Visit: http://localhost:3002

2. **Login (create user account):**
   - Email: Enter your email address
   - Name: Enter your name
   - Click "Login"
   
   You should see: "✅ Logged in as [Your Name]"

3. **Register a device:**
   - Device Name: Enter a descriptive name (e.g., "My Remote Server", "Production Machine")
   - Click "Register Device"
   - **IMPORTANT**: Copy the device token from the popup alert immediately
   - Save this token securely - you'll need it to connect from Claude Desktop

4. **Verify device status:**
   - Device should show as "OFFLINE" (red status) initially
   - This is normal - it will turn green when connected from Desktop Commander

### Step 3: Install/Update Desktop Commander

1. **Navigate to Desktop Commander directory:**
   ```bash
   cd /Users/dasein/dev/DC/DesktopCommanderMCP
   ```

2. **Install dependencies and build:**
   ```bash
   npm install
   npm run build
   ```

3. **Setup with Claude Desktop:**
   ```bash
   npm run setup
   ```

   This will configure Desktop Commander in your Claude Desktop settings.

### Step 4: Configure Claude Desktop for Remote MCP

1. **Open Claude Desktop settings:**
   - Open Claude Desktop application
   - Go to Settings (⚙️ icon)
   - Select "MCP Servers" or "Developer Settings"

2. **Verify Desktop Commander configuration:**
   Your `~/.claude/mcp_servers.json` should include:
   ```json
   {
     "mcpServers": {
       "desktop-commander": {
         "command": "npx",
         "args": [
           "@wonderwhy-er/desktop-commander"
         ],
         "env": {}
       }
     }
   }
   ```

3. **Restart Claude Desktop:**
   - Close Claude Desktop completely
   - Reopen Claude Desktop
   - You should now see the Remote MCP tools available

## 🔧 Using Remote MCP with Claude Desktop

### Step 1: Connect to Remote Machine

In Claude Desktop, use the new Remote MCP tools:

```
Please connect to my remote MCP server using:
- Server URL: ws://localhost:3002/ws  
- Device Token: [paste your device token here]
```

Claude will use the `connect_remote_mcp` tool automatically.

**Expected response:**
```
✅ Connected to Remote MCP Server successfully. Device ID: abc123-def456
```

### Step 2: Verify Connection Status

Ask Claude to check the connection:

```
Check my remote MCP connection status
```

Claude will use `get_remote_mcp_status` and show:
```
🟢 Remote MCP Status: Connected and authenticated. Device ID: abc123-def456
```

### Step 3: Execute Remote Commands

Now you can execute any MCP command on the remote machine:

#### Read Remote Files
```
Read the file /etc/hostname on the remote machine
```

#### List Remote Directories
```
List the contents of /home/user on the remote machine
```

#### Execute Remote Commands
```
Run the command "uname -a" on the remote machine
```

#### Get Remote File Information
```
Get information about the file /var/log/syslog on the remote machine
```

### Step 4: Disconnect When Done

```
Disconnect from the remote MCP server
```

Expected response:
```
✅ Disconnected from Remote MCP Server
```

## 🛠 Available Remote MCP Tools

Desktop Commander now includes these Remote MCP tools:

### 1. `connect_remote_mcp`
**Purpose:** Connect to a Remote MCP Server
**Parameters:**
- `serverUrl`: WebSocket URL (e.g., `ws://localhost:3002/ws`)
- `deviceToken`: Device token from the dashboard

### 2. `get_remote_mcp_status` 
**Purpose:** Check connection status
**Parameters:** None
**Returns:** Connection state, authentication status, device ID

### 3. `execute_remote_mcp`
**Purpose:** Execute MCP commands on remote machine
**Parameters:**
- `method`: MCP method name (e.g., `read_file`, `list_directory`, `start_process`)
- `params`: Optional parameters for the method

**Supported remote methods:**
- `read_file` - Read files
- `list_directory` - List directory contents  
- `start_process` - Execute commands
- `get_file_info` - Get file metadata
- `write_file` - Write/modify files
- `create_directory` - Create directories
- `move_file` - Move/rename files
- All other standard MCP methods supported by the remote machine

### 4. `disconnect_remote_mcp`
**Purpose:** Disconnect from Remote MCP Server  
**Parameters:** None

## 🔍 Testing Your Setup

### Test 1: Basic Connection Test
```bash
# In the remote-mcp-server directory
node test-device.js "YOUR_DEVICE_TOKEN_HERE"
```

Expected output:
```
📱 Test device client started
🔑 Using device token: eyJhbGciOiJIUzI1NiI...
💡 Tip: Register a device in the dashboard first, then copy the token here
Connecting to Remote MCP Server...
✅ Connected to Remote MCP Server
📨 Received: auth Please provide device token
📨 Received: auth Authentication successful
🎉 Authentication successful! Device ID: abc123-def456
```

### Test 2: Dashboard Integration Test
1. Keep the test device client running
2. Refresh the dashboard (http://localhost:3002)
3. Device status should show "ONLINE" (green)
4. Try the example MCP requests in the dashboard

### Test 3: Claude Desktop Integration Test
1. Stop the test device client (`Ctrl+C`)
2. Use Claude Desktop to connect via Remote MCP tools
3. Device should show "ONLINE" in dashboard
4. Execute remote commands through Claude

## 🚨 Troubleshooting

### Connection Issues

**Problem:** "Failed to connect to Remote MCP Server"
**Solutions:**
1. Verify server is running: Check http://localhost:3002
2. Check WebSocket URL format: Must be `ws://` or `wss://`
3. Verify device token is correct and not expired
4. Check firewall/network connectivity

**Problem:** Device shows "OFFLINE" in dashboard
**Solutions:**
1. Verify Desktop Commander is connected via Remote MCP tools
2. Check WebSocket connection in browser developer tools
3. Restart the Remote MCP server
4. Regenerate device token if needed

### Authentication Issues

**Problem:** "Authentication failed" or "Invalid device token"
**Solutions:**
1. Generate a new device token from the dashboard
2. Ensure token is copied completely (no extra spaces)
3. Check that device is registered for the correct user
4. Verify JWT_SECRET hasn't changed

### Command Execution Issues

**Problem:** Remote commands fail or timeout
**Solutions:**
1. Verify remote machine has necessary permissions
2. Check that MCP methods are available on remote system
3. Increase timeout values if needed
4. Check remote machine system resources

### Dashboard Issues

**Problem:** Cannot access dashboard at http://localhost:3002
**Solutions:**
1. Verify server is running: `npm run dev`
2. Check if port 3002 is available: `lsof -i :3002`
3. Try different port in .env file
4. Check server logs for errors

### Database Issues

**Problem:** Database connection errors
**Solutions:**
1. Verify PostgreSQL is running
2. Check database exists: `dc_app_dev3_tmp`
3. Verify connection string in .env file
4. Run database migrations: `npm run migrate`

## 🔐 Security Considerations

### Production Deployment
- **Change JWT_SECRET:** Use a long, random secret key
- **Use HTTPS:** Deploy with SSL certificates (`wss://` for WebSocket)
- **Database Security:** Use connection pooling and proper credentials
- **Rate Limiting:** Implement request rate limiting
- **Input Validation:** Validate all MCP requests
- **Network Security:** Use firewalls and VPNs for remote access

### Device Token Management
- **Token Rotation:** Regenerate tokens periodically
- **Secure Storage:** Store tokens securely, never in version control
- **Access Control:** Limit device registrations per user
- **Audit Logging:** Log all device connections and commands

## 📝 Advanced Configuration

### Custom Server URLs
For production or different environments:
```bash
# Local development
ws://localhost:3002/ws

# Production server
wss://your-domain.com/ws

# Different port
ws://localhost:8080/ws
```

### Environment Variables

```bash
# .env file options
PORT=3002                    # Server port
NODE_ENV=development         # Environment mode
JWT_SECRET="long-secret"     # JWT signing secret
POSTGRES_URL="postgres://..." # Database connection

# Optional OAuth (future)
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
OAUTH_REDIRECT_URI="..."
```

### Database Configuration
The server automatically creates required tables:
- `users` - User accounts
- `devices` - Registered devices (one per user)
- `sessions` - Authentication sessions

## 📊 Monitoring and Logs

### Server Logs
The Remote MCP server provides detailed logging:
- WebSocket connections/disconnections
- MCP request/response cycles
- Authentication events
- Database operations
- Error tracking

### Health Monitoring
Check server health:
```bash
curl http://localhost:3002/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-12-23T17:30:00.000Z",
  "connections": 1,
  "pendingRequests": 0
}
```

## 🆘 Support

### Common Use Cases
1. **Development:** Control development servers remotely
2. **Administration:** Manage production systems through Claude
3. **Automation:** Execute maintenance tasks via natural language
4. **Monitoring:** Check system status and logs remotely
5. **Deployment:** Run deployment scripts through Claude interface

### Getting Help
1. Check server logs for error messages
2. Verify all prerequisites are met
3. Test with the provided test client first
4. Ensure network connectivity between all components
5. Check Claude Desktop MCP server configuration

---

## ✨ Success! 

You now have a fully functional Remote MCP setup that allows Claude Desktop to control remote machines through natural language commands. The integration provides seamless remote system management with the familiar Desktop Commander interface.

**Happy Remote Computing! 🚀**