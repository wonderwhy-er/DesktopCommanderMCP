# Remote MCP Server - Complete Infrastructure Setup

🚀 **Control remote machines through Claude Desktop using MCP OAuth Specification with Desktop Commander tools**

This system provides a complete remote machine control solution with:
- **MCP Authorization Specification compliance** (OAuth 2.1 + PKCE)
- **Server-Sent Events (SSE)** for real-time communication
- **Environment variable configuration** for flexible deployment
- **Desktop Commander integration** for comprehensive file and process management

---

## 🏗 System Architecture

```mermaid
graph TB
    subgraph "Claude Desktop"
        Claude[Claude Desktop Client]
        Config[claude_desktop_config.json]
    end

    subgraph "MCP OAuth Infrastructure"
        AuthServer[OAuth Authorization Server<br/>Port 4449]
        MCPServer[MCP Resource Server<br/>Port 3006]
    end

    subgraph "Remote Infrastructure"
        RemoteServer[Remote Server<br/>Port 3002]
        Database[(PostgreSQL)]
    end

    subgraph "Target Machine"
        Agent[Local Agent]
        DesktopCmd[Desktop Commander]
    end

    Claude -->|OAuth 2.1 Flow| AuthServer
    Claude -->|SSE + Bearer Token| MCPServer
    MCPServer -->|Device Token Auth| RemoteServer
    RemoteServer -->|SSE| Agent
    Agent -->|MCP Commands| DesktopCmd
    
    Config -.-> Claude
    RemoteServer <--> Database
```

---

## 📋 Prerequisites

- **Node.js** (v18 or higher)
- **PostgreSQL** (for remote server database)
- **Claude Desktop** application
- **Desktop Commander MCP** (for target machine control)

---

## 🚀 Complete Setup Guide

### Step 1: Environment Configuration

Create and configure your `.env` file:

```bash
cd remote-mcp-server
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# MCP Specification Compliant Server Configuration
MCP_SERVER_HOST="localhost"
MCP_SERVER_PORT=3006
MCP_SERVER_URL="http://localhost:3006"

# OAuth Authorization Server Configuration
OAUTH_AUTH_HOST="localhost"
OAUTH_AUTH_PORT=4449
OAUTH_AUTH_SERVER_URL="http://localhost:4449"

# Remote Desktop Commander Server Configuration
REMOTE_DC_SERVER_HOST="localhost"
REMOTE_DC_SERVER_PORT=3002
REMOTE_DC_SERVER_URL="http://localhost:3002"

# Database Configuration
POSTGRES_URL="postgresql://username:password@localhost:5432/remote_mcp_db"

# JWT Configuration
JWT_SECRET="your-secure-random-jwt-secret-key-here"
```

### Step 2: Install Dependencies

```bash
# Install dependencies
npm install

# Build the project
npm run build
```

### Step 3: Database Setup

Start PostgreSQL and create the database:

```bash
# Create database
createdb remote_mcp_db

# Run migrations (if available)
npm run migrate
```

### Step 4: Start Infrastructure Components

#### Option A: Quick Start (All-in-One)

Start the complete MCP OAuth infrastructure:

```bash
# Start with monitoring and auto-restart
node monitor-mcp-server.js
```

This starts:
- **MCP Resource Server**: `http://localhost:3006` (SSE endpoint: `/sse`)
- **OAuth Authorization Server**: `http://localhost:4449` (built-in demo provider)
- **Health monitoring** with automatic restart on failures

#### Option B: Manual Component Startup

Start each component individually:

```bash
# 1. Start OAuth-compliant MCP server
node mcp-server-spec-compliant.js

# 2. In another terminal, start traditional remote server (if needed)
npm run dev

# 3. Verify services are running
curl http://localhost:3006/health
curl http://localhost:4449/.well-known/oauth-authorization-server
```

### Step 5: Setup Target Machine Agent

On the machine you want to control remotely:

#### 5a. Install Desktop Commander

```bash
# Clone and setup Desktop Commander on target machine
git clone https://github.com/yourusername/DesktopCommanderMCP.git
cd DesktopCommanderMCP
npm install
npm run build
```

#### 5b. Get Device Token

**Option A: Command Line**
```bash
node get-device-token.js --email your@email.com --name "Your Name" --device "Target Machine Name"
```

**Option B: Web Dashboard**
```bash
# Open web interface
open http://localhost:3002

# Login and register device, copy the device token
```

#### 5c. Start Local Agent

```bash
# Start the agent on target machine
./agent.js http://localhost:3002 "YOUR_DEVICE_TOKEN_HERE"
```

Expected output:
```
🚀 Starting Local MCP Agent (Proxy Mode)...
🔌 Connecting to Desktop Commander MCP...
📡 Connecting to SSE endpoint...
✅ SSE connection established
🎉 Connected to Remote MCP Server
```

---

## 🔗 Claude Desktop Integration

### Method 1: MCP OAuth Specification (Recommended)

Configure Claude Desktop to use the OAuth-compliant MCP server:

#### Step 1: Configure Claude Desktop

Find your Claude Desktop config directory:
- **macOS**: `~/Library/Application Support/Claude/`
- **Windows**: `%APPDATA%\Claude\`
- **Linux**: `~/.config/Claude/`

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "remote-mcp-oauth": {
      "command": "node",
      "args": ["/path/to/remote-mcp-server/mcp-server-oauth-connector.js"],
      "env": {
        "MCP_SERVER_URL": "http://localhost:3006",
        "OAUTH_AUTH_SERVER_URL": "http://localhost:4449"
      }
    }
  }
}
```

**Update the path** to match your actual installation directory.

#### Step 2: OAuth Authentication Flow

1. **Start Claude Desktop** (restart completely after config change)

2. **Begin OAuth flow in Claude Desktop:**
   ```
   Please authenticate with the remote MCP server
   ```

3. **Complete OAuth authorization:**
   - Claude Desktop will provide an authorization URL
   - Open the URL in your browser
   - Complete the OAuth flow (demo provider auto-approves)
   - Return to Claude Desktop with the authorization code

4. **Test the connection:**
   ```
   Check remote MCP server status
   ```

#### Step 3: Using Remote Commands

Once authenticated, use natural language commands:

```
Read the file /etc/hosts on the remote machine
```

```
List the contents of /home directory on the remote machine
```

```
Run the command "df -h" on the remote machine
```

```
Create a file called test.txt with content "Hello from Claude!" on the remote machine
```

### Method 2: Desktop Commander Integration (Alternative)

Use the existing Desktop Commander setup:

#### Step 1: Configure Desktop Commander

```bash
cd /path/to/DesktopCommanderMCP
npm install
npm run build
npm run setup
```

#### Step 2: Connect via Desktop Commander

In Claude Desktop, send:
```
Please connect to my remote MCP server using:
- Server URL: http://localhost:3002
- Device Token: YOUR_DEVICE_TOKEN_HERE
```

---

## 🧪 Testing & Verification

### Test OAuth Flow

Run the complete OAuth flow test:

```bash
node test-full-oauth-flow.js
```

Expected output:
```
🚀 Starting complete OAuth flow test
📝 Step 1: Register OAuth client ✅
🔐 Step 2: Generate PKCE parameters ✅
📨 Step 3: Get authorization code ✅
🔄 Step 4: Exchange code for access token ✅
🔍 Step 5: Test token introspection ✅
🎯 Step 6: Test MCP server access with token ✅
📡 Step 7: Test SSE endpoint with authentication ✅
```

### Health Checks

```bash
# Check MCP server health
curl http://localhost:3006/health

# Check OAuth server metadata
curl http://localhost:4449/.well-known/oauth-authorization-server

# Check remote server health
curl http://localhost:3002/health

# Check SSE connections
curl http://localhost:3002/sse/status
```

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
    "method": "tools/call",
    "params": {
      "name": "read_file",
      "arguments": {"path": "/etc/hosts"}
    }
  }'
```

---

## 🔧 Production Deployment

### Environment Variables for Production

Update your `.env` for production:

```env
NODE_ENV=production

# Use HTTPS URLs in production
MCP_SERVER_URL="https://your-domain.com:3006"
OAUTH_AUTH_SERVER_URL="https://your-auth-domain.com:4449"
REMOTE_DC_SERVER_URL="https://your-remote-domain.com:3002"

# Secure database connection
POSTGRES_URL="postgresql://user:pass@db-host:5432/remote_mcp_prod"

# Strong JWT secret
JWT_SECRET="your-256-bit-production-secret-key"

# OAuth security settings
OAUTH_SCOPES="mcp:tools mcp:admin"
OAUTH_CLIENT_SECRET="your-secure-oauth-client-secret"
```

### Ory Hydra/Kratos Integration (Production OAuth)

For production OAuth with Ory Hydra and Kratos:

```bash
# Start Ory services
docker-compose -f docker-compose.oauth.yml up -d

# Update environment variables
ORY_HYDRA_ADMIN_URL="http://localhost:4445"
ORY_HYDRA_PUBLIC_URL="http://localhost:4444"
ORY_KRATOS_ADMIN_URL="http://localhost:4434"
ORY_KRATOS_PUBLIC_URL="http://localhost:4433"
```

See `docs/ORY_INTEGRATION_GUIDE.md` for complete Ory setup instructions.

### Docker Deployment

```bash
# Build and run with Docker
docker build -t remote-mcp-server .
docker run -d \
  --name remote-mcp \
  -p 3006:3006 \
  -p 4449:4449 \
  -e NODE_ENV=production \
  --env-file .env \
  remote-mcp-server
```

---

## 🛠 Configuration Reference

### Environment Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MCP_SERVER_HOST` | MCP server hostname | `localhost` | `0.0.0.0` |
| `MCP_SERVER_PORT` | MCP server port | `3006` | `3006` |
| `MCP_SERVER_URL` | Full MCP server URL | `http://localhost:3006` | `https://mcp.domain.com` |
| `OAUTH_AUTH_PORT` | OAuth server port | `4449` | `4449` |
| `OAUTH_AUTH_SERVER_URL` | OAuth server URL | `http://localhost:4449` | `https://auth.domain.com` |
| `REMOTE_DC_SERVER_URL` | Remote server URL | `http://localhost:3002` | `https://remote.domain.com` |
| `POSTGRES_URL` | Database connection | See example | PostgreSQL URL |
| `JWT_SECRET` | JWT signing secret | Required | 256-bit secret |

### OAuth Endpoints

| Endpoint | Description | Port |
|----------|-------------|------|
| `GET /sse` | MCP SSE communication (requires Bearer token) | 3006 |
| `POST /message` | MCP message endpoint | 3006 |
| `GET /health` | Health check and server info | 3006 |
| `GET /.well-known/oauth-authorization-server` | OAuth metadata (RFC 8414) | 4449 |
| `GET /authorize` | OAuth authorization endpoint | 4449 |
| `POST /token` | OAuth token exchange | 4449 |
| `POST /register` | Dynamic client registration | 4449 |
| `POST /introspect` | Token introspection (RFC 7662) | 4449 |

### Supported MCP Methods

The system supports all Desktop Commander MCP methods:

- **File Operations**: `read_file`, `write_file`, `list_directory`, `create_directory`, `move_file`, `get_file_info`
- **Process Management**: `start_process`, `interact_with_process`, `read_process_output`, `force_terminate`
- **Search Operations**: `start_search`, `get_more_search_results`, `stop_search`
- **Content Editing**: `edit_block`
- **Session Management**: `list_sessions`

---

## 🚨 Troubleshooting

### Common Issues

**❌ "Authentication required"**
```bash
# Check OAuth server is running
curl http://localhost:4449/.well-known/oauth-authorization-server

# Verify MCP server accepts requests
curl -H "Authorization: Bearer test" http://localhost:3006/health
```

**❌ "Connection refused"**
```bash
# Check if ports are available
lsof -i :3006
lsof -i :4449

# Restart with monitoring
node monitor-mcp-server.js
```

**❌ "Device token expired"**
```bash
# Generate new device token
node get-device-token.js --email your@email.com --name "Your Name" --device "Your Device"

# Restart agent with new token
./agent.js http://localhost:3002 "NEW_TOKEN_HERE"
```

**❌ "OAuth flow fails"**
```bash
# Test OAuth flow
node test-full-oauth-flow.js

# Check for detailed logs
tail -f logs/mcp-oauth-server-*.log
```

### Debug Mode

Enable debug logging:

```bash
export DEBUG=mcp:*
export LOG_LEVEL=debug
node monitor-mcp-server.js
```

### Health Monitoring

Monitor system status:

```bash
# Real-time log monitoring
tail -f logs/mcp-oauth-server-*.log | jq .

# System resource monitoring
node monitor-mcp-server.js
```

---

## 📚 Additional Documentation

- **[Comprehensive Documentation](COMPREHENSIVE_DOCUMENTATION.md)** - Complete system overview
- **[Workflow Diagrams](docs/WORKFLOW_DIAGRAMS.md)** - Visual system architecture
- **[Ory Integration Guide](docs/ORY_INTEGRATION_GUIDE.md)** - Production OAuth setup
- **[OAuth Success Report](logs/OAUTH_SUCCESS_REPORT.md)** - Implementation verification

---

## 🔐 Security Considerations

- **HTTPS in Production**: Always use HTTPS for production deployments
- **JWT Secret**: Use a strong, randomly generated JWT secret
- **Token Expiration**: Configure appropriate token expiration times
- **CORS Configuration**: Restrict CORS origins in production
- **Rate Limiting**: Implement rate limiting for public endpoints
- **Audit Logging**: Enable comprehensive audit logging
- **Network Security**: Use firewalls and VPNs for remote access

---

## 🎯 Features

✅ **MCP Authorization Specification Compliant**  
✅ **OAuth 2.1 with PKCE Support**  
✅ **Server-Sent Events (SSE) Transport**  
✅ **Bearer Token Authentication**  
✅ **Environment Variable Configuration**  
✅ **Health Monitoring & Auto-restart**  
✅ **PostgreSQL Database Integration**  
✅ **Docker Support**  
✅ **Ory Hydra/Kratos Integration**  
✅ **Complete Test Suite**  
✅ **Production Ready**  

---

**🚀 Your Remote MCP Server infrastructure is now ready for production use with Claude Desktop!**

For support or questions, refer to the comprehensive documentation or check the troubleshooting section above.