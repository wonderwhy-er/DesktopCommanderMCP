# Supabase MCP Server

A complete OAuth 2.0 authenticated MCP (Model Context Protocol) server using Supabase as the backend with HTTP transport for real-time communication with Claude Desktop.

## 🚀 **Features**

- **OAuth 2.0 + PKCE** - Industry standard authentication with browser-based flow
- **HTTP Transport** - Direct HTTP communication for MCP protocol
- **Supabase Integration** - Complete backend with user management and data persistence
- **OAuth Discovery** - RFC 8414 compliant authorization server metadata
- **User-Scoped Tools** - All tools isolated to authenticated users
- **Session Management** - Persistent authentication sessions with expiry
- **Audit Logging** - Complete tool call history and usage tracking
- **Rate Limiting** - 100 requests/minute per authenticated user
- **Production Ready** - Security headers, CORS, error handling

## 📋 **OAuth 2.0 Endpoints (MCP Compliant)**

The server implements a complete OAuth 2.0 authorization server following the MCP specification:

- **`/authorize`** - Authorization endpoint with PKCE and resource parameter support
- **`/token`** - Token endpoint with PKCE validation and resource indicators
- **`/register`** - Client registration endpoint (Claude Desktop pre-registered)
- **`/.well-known/oauth-authorization-server`** - Authorization server metadata (RFC 8414)
- **`/.well-known/oauth-protected-resource`** - Protected resource metadata

### MCP Compliance Features
- ✅ **Resource Indicators** (RFC 8707) - `resource` parameter support
- ✅ **PKCE Required** - S256 code challenge validation
- ✅ **Claude Desktop Pre-registered** - Client ID: `claude-desktop`
- ✅ **Out-of-Band Redirect** - `urn:ietf:wg:oauth:2.0:oob` support
- ✅ **Comprehensive Logging** - All OAuth flows logged with emojis

## 🗄️ **Database Schema**

The server uses the following Supabase database schema:

### Users Table (`auth.users`)
Built-in Supabase authentication table for user management.

### MCP Sessions Table (`mcp_sessions`)
```sql
CREATE TABLE IF NOT EXISTS mcp_sessions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    session_token text NOT NULL,
    client_info jsonb,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    is_active boolean DEFAULT true
);
```

### MCP Tool Calls Table (`mcp_tool_calls`)
```sql
CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    tool_name varchar(255) NOT NULL,
    arguments jsonb,
    result jsonb,
    duration_ms integer,
    success boolean NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now()
);
```

### Row Level Security (RLS) Policies

**MCP Sessions RLS:**
```sql
-- Users can only access their own sessions
CREATE POLICY "Users can manage own sessions" ON mcp_sessions
    FOR ALL USING (auth.uid() = user_id);
```

**MCP Tool Calls RLS:**
```sql
-- Users can only access their own tool calls
CREATE POLICY "Users can manage own tool calls" ON mcp_tool_calls
    FOR ALL USING (auth.uid() = user_id);
```

### Indexes for Performance
```sql
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user_id ON mcp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_token ON mcp_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_user_id ON mcp_tool_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_created_at ON mcp_tool_calls(created_at);
```

## 🏗️ Architecture

### Components

1. **MCP Server** (`src/server/mcp-server.js`) - Main server with integrated OAuth endpoints
2. **Web Interface** (`src/web/public/`) - Integrated authentication portal  
3. **HTTP Connector** (`src/client/http-connector.js`) - Claude Desktop bridge
4. **Tools** (`src/server/tools/`) - MCP tool implementations

## 🚀 Quick Start

### Prerequisites

- Node.js 16+ 
- Supabase account and project
- Claude Desktop (for MCP integration)

### 1. Installation

```bash
git clone <repository-url>
cd supabase-mcp
npm install
```

### 2. Environment Configuration

Create `.env` file with simplified configuration:

```bash
# ==========================================
# CORE SERVER CONFIGURATION
# ==========================================

# MCP Server URL - Use tunnel URL for Claude Desktop integration
MCP_SERVER_URL=http://localhost:3007  # or https://your-tunnel.trycloudflare.com
MCP_SERVER_HOST=localhost
MCP_SERVER_PORT=3007
NODE_ENV=development

# ==========================================
# SUPABASE CONFIGURATION
# ==========================================

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# ==========================================
# SECURITY CONFIGURATION
# ==========================================

SESSION_SECRET=your-session-secret-change-in-production
JWT_SECRET=your-jwt-secret-change-in-production
DEBUG_MODE=true

# ==========================================
# REMOVED LEGACY SETTINGS
# ==========================================

# These are NO LONGER NEEDED (auto-derived from MCP_SERVER_URL):
# WEB_SERVER_PORT=3008          ❌ Removed
# WEB_APP_URL=http://localhost:3008  ❌ Removed  
# OAUTH_REDIRECT_URL=...        ❌ Auto-derived
# CORS_ORIGINS=[...]            ❌ Auto-derived
```

### 3. Database Setup

```bash
npm run setup
```

This will display the SQL commands needed to set up your database. **Manual setup required:**

1. **Run the setup command** above to see the SQL commands
2. **Go to Supabase Dashboard → SQL Editor** 
3. **Copy and paste** the displayed SQL commands (or use `setup.sql` file)
4. **Run the commands** to create tables and policies

Alternatively, you can copy the contents of `setup.sql` directly into the SQL Editor.

### 4. Start MCP Server

```bash
# Start the MCP server with integrated web interface
npm start
```

The server will start on http://localhost:3007 with integrated OAuth endpoints.

## 🔗 **Claude Desktop Integration**

### Configuration

Add to your Claude Desktop MCP configuration:

**Location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": ["/path/to/supabase-mcp/src/client/http-connector.js"],
      "env": {
        "MCP_SERVER_URL": "http://localhost:3007",
        "DEBUG_MODE": "true"
      }
    }
  }
}
```

### Expected Claude Desktop Flow

The server follows the MCP authorization specification for Claude Desktop integration:

```
Claude Desktop → Discovery → Authorization → Web Login → Token Exchange → MCP Connection
```

**Detailed Steps:**
1. **Claude Desktop discovers OAuth endpoints** via `/.well-known/oauth-authorization-server`
2. **Initiates authorization** with PKCE to `/authorize` including `resource` parameter
3. **Browser opens** to MCP server web interface at `/auth.html`
4. **User authenticates** with Supabase (sign in/sign up)
5. **Redirects back** with authorization code including PKCE validation
6. **Claude Desktop exchanges code** for token via `/token` with PKCE verification
7. **Uses Bearer token** for authenticated MCP communication

### OAuth Flow

1. **Add Configuration** → Restart Claude Desktop
2. **OAuth Discovery** → Claude Desktop discovers endpoints automatically  
3. **Browser Opens** → PKCE-secured OAuth flow starts
4. **Authenticate** → Sign in/up with Supabase account
5. **Token Exchange** → Automatic PKCE validation and token exchange
6. **Connected** → MCP tools become available with Bearer authentication

## 🛠️ **Available Tools**

### Core Tools

```javascript
// Test connectivity
{ "name": "echo", "arguments": { "text": "Hello!" } }

// Get authenticated user info
{ "name": "user_info", "arguments": { "include_metadata": true } }

// Query user data
{ "name": "supabase_query", "arguments": { 
    "table": "mcp_tool_calls", 
    "limit": 10 
}}
```

### Tool Descriptions

- **`echo`** - Simple connectivity test that returns input text
- **`user_info`** - Returns authenticated user profile and metadata
- **`supabase_query`** - Query user-scoped data from Supabase tables

## 🔧 **Development**

### Available Scripts

```bash
# Start server
npm start
npm run dev

# Test OAuth flow
npm run test-flow

# Test direct connector
npm run connector

# Database setup
npm run setup
```

### Server Endpoints

- **`GET /health`** - Server health check
- **`GET /.well-known/oauth-authorization-server`** - OAuth discovery
- **`GET /authorize`** - OAuth authorization
- **`POST /token`** - Token exchange
- **`POST /register`** - Client registration
- **`POST /mcp-direct`** - Direct MCP endpoint (authenticated)

## 🔒 **Security Features**

### Authentication & Authorization

- **OAuth 2.0 + PKCE** - Secure authorization flow
- **JWT Validation** - Supabase token verification
- **Row Level Security** - Database-level access control
- **Session Management** - Secure token storage and expiry

### Request Security

- **Rate Limiting** - 100 requests/minute per user
- **CORS Protection** - Configurable origin restrictions
- **Security Headers** - XSS, content-type, frame protection
- **Input Validation** - Request parameter validation

### Data Protection

- **User Isolation** - All data scoped to authenticated user
- **Audit Logging** - Complete tool call history
- **Session Expiry** - Automatic token expiration (24 hours)
- **Error Handling** - Secure error messages without data leakage

## 🌐 **Production Deployment**

### 1. Environment Setup

Update `.env` for production:

```bash
NODE_ENV=production
MCP_SERVER_URL=https://your-domain.com
MCP_SERVER_HOST=0.0.0.0
MCP_SERVER_PORT=3007
```

### 2. HTTPS/SSL

Ensure HTTPS is configured for OAuth security:

```bash
# Using Cloudflare Tunnel (example)
cloudflared tunnel --url http://localhost:3007
```

### 3. Security Checklist

- ✅ HTTPS/SSL configured
- ✅ Environment variables secured
- ✅ Rate limiting enabled
- ✅ CORS properly configured
- ✅ Database RLS policies active

## 📊 **Monitoring**

### Health Endpoint

```bash
curl http://localhost:3007/health
```

Response:
```json
{
  "status": "healthy",
  "service": "supabase-mcp-server",
  "version": "1.0.0",
  "uptime": {
    "human": "2h 15m",
    "seconds": 8100
  },
  "requests": {
    "total": 156,
    "rate": 0.02
  }
}
```

### User Statistics

Authenticated users can access their usage stats:

```bash
curl -H "Authorization: Bearer <token>" \
     http://localhost:3007/stats
```

## 📚 **API Reference**

### OAuth 2.0 Endpoints

#### Authorization Endpoint
```http
GET /authorize?response_type=code&client_id=<id>&redirect_uri=<uri>&scope=mcp:tools&state=<state>
```

#### Token Endpoint
```http
POST /token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "<auth_code>",
  "redirect_uri": "<redirect_uri>",
  "client_id": "<client_id>",
  "code_verifier": "<code_verifier>"
}
```

### MCP Endpoints

#### Direct MCP Endpoint
```http
POST /mcp-direct
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "123",
  "method": "tools/list",
  "params": {}
}
```

## 🤝 **Contributing**

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 **License**

MIT License - see LICENSE file for details.

## 🆘 **Support**

- **Issues**: GitHub Issues
- **Documentation**: This README
- **Examples**: See `test/` directory