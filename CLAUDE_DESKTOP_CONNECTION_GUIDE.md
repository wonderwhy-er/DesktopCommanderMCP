# Complete Guide: Connecting Remote MCP to Claude Desktop

## 🎯 **Overview**
This guide shows you exactly how to connect the SSE-based Remote MCP to Claude Desktop (Claude Code) so you can control remote machines through natural language.

## 🚀 **Step-by-Step Connection Process**

### **Step 1: Get Your Device Token**

1. **Open the Remote MCP Dashboard:**
   ```
   http://localhost:3002
   ```

2. **Login to create your account:**
   - Email: `test@example.com` (or your email)
   - Name: `Test User` (or your name)
   - Click **"Login"**
   
   You should see: ✅ "Logged in as Test User"

3. **Register your device:**
   - Device Name: `My Remote Computer` (or any descriptive name)
   - Click **"Register Device"**
   - **IMPORTANT**: A popup will appear with your device token
   - **Copy the entire token** - it looks like this:
   ```
   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6ImFiYzEyMy1kZWY0NTYiLCJ1c2VySWQiOiI3ODkiLCJ0eXBlIjoiZGV2aWNlIiwiaWF0IjoxNjM5NTg0MDAwLCJleHAiOjE2NDIxNzYwMDB9.signature
   ```

**⚠️ SAVE THIS TOKEN IMMEDIATELY** - you cannot retrieve it again!

### **Step 2: Install/Update Desktop Commander**

1. **Navigate to Desktop Commander:**
   ```bash
   cd /Users/dasein/dev/DC/DesktopCommanderMCP
   ```

2. **Install dependencies and build:**
   ```bash
   npm install
   npm run build
   ```

3. **Setup Desktop Commander in Claude Desktop:**
   ```bash
   npm run setup
   ```

4. **Restart Claude Desktop:**
   - Completely close Claude Desktop app
   - Reopen Claude Desktop
   - You should now see Remote MCP tools available

### **Step 3: Start the Local Agent (Remote Machine)**

On the machine you want to control remotely:

```bash
cd /Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server

# Start the local agent with YOUR device token
./agent.js http://localhost:3002 "YOUR_DEVICE_TOKEN_HERE"
```

**Replace `YOUR_DEVICE_TOKEN_HERE` with the actual token from Step 1.**

Expected output:
```
🚀 Starting Local MCP Agent...
🔗 Server URL: http://localhost:3002
🔑 Device Token: eyJhbGciOiJIUzI1NiI...
📡 Connecting to SSE endpoint: http://localhost:3002/sse?deviceToken=...
✅ SSE connection established
🎉 Connected to Remote MCP Server
📱 Device ID: abc123-def456
```

### **Step 4: Connect in Claude Desktop**

Open Claude Desktop and start a new conversation. Use this exact format:

```
Please connect to my remote MCP server using these details:
- Server URL: http://localhost:3002
- Device Token: YOUR_DEVICE_TOKEN_HERE
```

**Replace `YOUR_DEVICE_TOKEN_HERE` with your actual device token.**

Claude will automatically use the `connect_remote_mcp` tool and respond with:
```
✅ Connected to Remote MCP Server via SSE successfully. Device ID: abc123-def456
```

### **Step 5: Execute Remote Commands**

Now you can control the remote machine through natural language:

#### **Read Remote Files:**
```
Read the file /etc/hostname on the remote machine
```

#### **List Remote Directories:**
```
Show me the contents of the /home directory on the remote machine
```

#### **Execute Remote Commands:**
```
Run the command "uname -a" on the remote machine
```

#### **Check Remote System:**
```
Get information about the file /etc/passwd on the remote machine
```

#### **Create Files Remotely:**
```
Create a file called test.txt with content "Hello from Remote MCP" on the remote machine
```

## 📍 **Exact Token Placement Examples**

### **Example 1: Real Device Token**
If your device token is:
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6IjEyMzQ1Njc4LTkwYWItY2RlZi1mZ2hpLTEyMzQ1Njc4OTBhYiIsInVzZXJJZCI6Ijk4NzY1NDMyLTEwZmUtZGNiYS05ODc2LTU0MzIxMGZlZGNiYSIsInR5cGUiOiJkZXZpY2UiLCJpYXQiOjE3MDM0NTI4MDAsImV4cCI6MTcwNjA0NDgwMH0.abcdef123456789
```

**Local Agent Command:**
```bash
./agent.js http://localhost:3002 "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6IjEyMzQ1Njc4LTkwYWItY2RlZi1mZ2hpLTEyMzQ1Njc4OTBhYiIsInVzZXJJZCI6Ijk4NzY1NDMyLTEwZmUtZGNiYS05ODc2LTU0MzIxMGZlZGNiYSIsInR5cGUiOiJkZXZpY2UiLCJpYXQiOjE3MDM0NTI4MDAsImV4cCI6MTcwNjA0NDgwMH0.abcdef123456789"
```

**Claude Desktop Message:**
```
Please connect to my remote MCP server using these details:
- Server URL: http://localhost:3002
- Device Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6IjEyMzQ1Njc4LTkwYWItY2RlZi1mZ2hpLTEyMzQ1Njc4OTBhYiIsInVzZXJJZCI6Ijk4NzY1NDMyLTEwZmUtZGNiYS05ODc2LTU0MzIxMGZlZGNiYSIsInR5cGUiOiJkZXZpY2UiLCJpYXQiOjE3MDM0NTI4MDAsImV4cCI6MTcwNjA0NDgwMH0.abcdef123456789
```

## 🔍 **Verification Steps**

### **1. Check Connection Status:**
In Claude Desktop:
```
Check my remote MCP connection status
```
Expected: 🟢 Remote MCP Status: Connected and authenticated

### **2. Verify Dashboard:**
- Go to http://localhost:3002
- Your device should show "ONLINE" (green status)

### **3. Test Simple Command:**
```
Read the file /etc/hosts on the remote machine
```

## 🐛 **Troubleshooting**

### **Problem: "Failed to connect to Remote MCP Server"**

**Check:**
1. ✅ Remote MCP Server running: `http://localhost:3002/health`
2. ✅ Device token copied correctly (no extra spaces)
3. ✅ Local agent running and connected
4. ✅ Desktop Commander built and setup in Claude Desktop

**Fix:**
```bash
# 1. Restart Remote MCP Server
cd /Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server
npm run dev

# 2. Restart Local Agent  
./agent.js http://localhost:3002 "YOUR_TOKEN"

# 3. Rebuild Desktop Commander
cd /Users/dasein/dev/DC/DesktopCommanderMCP
npm run build
npm run setup
```

### **Problem: "Device not connected or authenticated"**

**Check:**
1. Local agent shows "🎉 Connected to Remote MCP Server"
2. Dashboard shows device as "ONLINE"
3. Token hasn't expired

### **Problem: Device shows "OFFLINE" in dashboard**

**Fix:**
1. Restart the local agent
2. Check network connectivity  
3. Regenerate device token if needed

## 📋 **Quick Reference**

### **Commands Summary:**
```bash
# Get device token
Open http://localhost:3002 → Login → Register Device → Copy Token

# Start local agent
./agent.js http://localhost:3002 "YOUR_TOKEN"

# Connect in Claude Desktop
"Connect to server http://localhost:3002 with token YOUR_TOKEN"

# Test connection
"Check remote MCP status"
"Read /etc/hostname on remote machine"
```

### **File Locations:**
- **Remote MCP Server**: `/Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server/`
- **Local Agent**: `/Users/dasein/dev/DC/DesktopCommanderMCP/remote-mcp-server/agent.js`
- **Desktop Commander**: `/Users/dasein/dev/DC/DesktopCommanderMCP/`
- **Dashboard**: `http://localhost:3002`

## 🎉 **Success Indicators**

### **When Everything Works:**
1. **Dashboard**: Device shows "ONLINE" (green)
2. **Local Agent**: Shows "🎉 Connected to Remote MCP Server"  
3. **Claude Desktop**: Can execute remote commands
4. **Health Check**: `curl http://localhost:3002/health` shows `sseConnections: 1`

### **Example Successful Workflow:**
```
You: "Connect to server http://localhost:3002 with token eyJhbGci..."
Claude: ✅ Connected to Remote MCP Server via SSE successfully

You: "Read /etc/hostname on remote machine" 
Claude: ✅ Remote MCP command 'read_file' executed successfully:
{
  "content": "my-computer\n",
  "lineCount": 1,
  "totalLines": 1
}

You: "Run 'uname -a' on remote machine"
Claude: ✅ Remote MCP command 'start_process' executed successfully:
{
  "output": "Linux my-computer 5.4.0-74-generic #83-Ubuntu...",
  "exitCode": 0
}
```

**🚀 You're now controlling remote machines through Claude Desktop!**