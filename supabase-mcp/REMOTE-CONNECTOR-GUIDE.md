# How to Use Supabase MCP as Remote Connector with SSE

This guide shows how to use the Supabase MCP Server as a remote connector with Server-Sent Events (SSE) transport for Claude Desktop.

## Overview

The Supabase MCP Server provides:
- **OAuth Authentication** via Supabase
- **SSE Transport** for real-time communication
- **Remote MCP Connection** to Claude Desktop
- **User-Scoped Tools** with session management

## Prerequisites

1. **Supabase Account** - Create at [supabase.com](https://supabase.com)
2. **Claude Desktop** - Latest version with MCP support
3. **Node.js 16+** - For running the server

## Step 1: Setup Supabase MCP Server

### 1.1 Install and Configure

```bash
# Clone and install
git clone <repository-url>
cd supabase-mcp
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Supabase credentials:
# SUPABASE_URL=https://your-project.supabase.co
# SUPABASE_ANON_KEY=your-anon-key
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### 1.2 Database Setup

```bash
# Run setup command (provides SQL commands)
npm run setup

# Copy the SQL commands and run them in Supabase SQL Editor:
# 1. Go to Supabase Dashboard → SQL Editor
# 2. Paste and run the provided SQL commands
# 3. This creates mcp_sessions and mcp_tool_calls tables
```

### 1.3 Start MCP Server

```bash
# Start the server with integrated OAuth
npm start

# Server will be available at:
# - MCP Server: http://localhost:3007
# - OAuth: http://localhost:3007/authorize
# - Health: http://localhost:3007/health
```

## Step 2: Configure Claude Desktop

### 2.1 Add MCP Server Configuration

Add to your Claude Desktop MCP configuration file:

**Location:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": ["src/client/sse-connector.js"],
      "env": {
        "MCP_SERVER_URL": "http://localhost:3007"
      }
    }
  }
}
```

**Note:** No access tokens needed! OAuth handles authentication automatically.

### 2.2 Restart Claude Desktop

After adding the configuration:
1. **Close Claude Desktop** completely
2. **Restart Claude Desktop**
3. **OAuth flow will begin** automatically

## Step 3: Complete OAuth Authentication

### 3.1 OAuth Flow Process

When Claude Desktop starts:

1. **Browser Opens Automatically** 
   - Claude Desktop detects no access token
   - SSE Connector opens browser to OAuth page
   - URL: `http://localhost:3007/authorize?...`

2. **Authentication Page Loads**
   - Supabase-powered login/signup interface
   - Shows OAuth client information
   - Secure authentication flow

3. **Sign In or Sign Up**
   - **Existing User**: Enter your Supabase credentials
   - **New User**: Create account with email/password
   - Supabase handles all authentication

4. **Automatic Connection**
   - After successful authentication
   - Browser redirects with access tokens
   - Claude Desktop connects automatically
   - MCP tools become available

### 3.2 What You'll See

**In Browser:**
```
🔐 OAuth Authorization Request
Client: mcp-connector
Scopes: mcp:tools
Redirect: http://localhost:8847/callback

Please sign in to authorize this application.

[Email input]
[Password input]
[Sign In & Authorize Button]
```

**In Claude Desktop:**
- Tools become available after authentication
- No manual configuration needed
- Persistent sessions (24 hours)

## Step 4: Available Tools

Once authenticated, you'll have access to:

### Core Tools

```javascript
// Echo tool for testing
{
  "name": "echo",
  "description": "Echo back the input text",
  "arguments": { "text": "Hello, MCP!" }
}

// User information
{
  "name": "user_info", 
  "description": "Get current user information",
  "arguments": { "include_metadata": true }
}

// Database queries
{
  "name": "supabase_query",
  "description": "Execute read-only queries",
  "arguments": {
    "table": "mcp_tool_calls",
    "columns": "*",
    "limit": 10
  }
}
```

### Session Management

- **Automatic Sessions** - Created on authentication
- **24-Hour Expiry** - Sessions auto-expire
- **User Isolation** - RLS ensures data security
- **Activity Tracking** - All tool calls logged

## Step 5: Testing the Connection

### 5.1 Manual Testing

```bash
# Test OAuth flow manually
MCP_SERVER_URL=http://localhost:3007 node src/client/sse-connector.js

# This will:
# 1. Detect no access token
# 2. Open browser for OAuth
# 3. Show authentication page
# 4. Wait for completion
```

### 5.2 Automated Testing

```bash
# Run comprehensive test suite
npm run test-oauth

# Tests OAuth flow and connection
```

### 5.3 Health Check

```bash
# Check server health
curl http://localhost:3007/health

# Expected response:
{
  "status": "healthy",
  "service": "supabase-mcp-server", 
  "version": "1.0.0",
  "uptime": "5m 32s"
}
```

## Architecture

### Remote MCP with SSE Transport

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Claude        │    │ SSE Connector    │    │ Supabase MCP    │
│   Desktop       │◄──►│ (sse-connector.  │◄──►│ Server          │
│                 │    │  js)             │    │ (Port 3007)     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │                       │
                                │                       ▼
                       ┌────────▼────────┐    ┌─────────────────┐
                       │ OAuth Flow      │    │ Supabase        │
                       │ (Browser)       │◄──►│ Authentication  │
                       └─────────────────┘    └─────────────────┘
```

### Communication Flow

1. **HTTP/SSE Transport** - Real-time bidirectional communication
2. **OAuth Authentication** - Secure token-based authentication  
3. **Session Management** - Database-backed user sessions
4. **Tool Execution** - User-scoped tool calls with logging

## Security Features

### Authentication & Authorization
- **Supabase JWT Tokens** - Industry-standard authentication
- **Row Level Security** - Database-level access control
- **Session Expiry** - 24-hour automatic token expiry
- **User Isolation** - Each user sees only their data

### Network Security
- **Rate Limiting** - 100 requests/minute per user
- **CORS Protection** - Configurable origin restrictions
- **Request Validation** - Comprehensive input validation
- **Error Sanitization** - Safe error messages

### Data Protection
- **Encrypted Transport** - HTTPS ready for production
- **Token Security** - Secure token storage and validation
- **Audit Trail** - Complete tool call logging
- **Database Encryption** - Supabase handles encryption at rest

## Troubleshooting

### Common Issues

**1. OAuth Browser Not Opening**
```bash
# Check if server is running
curl http://localhost:3007/health

# Manually open OAuth URL
open "http://localhost:3007/authorize?response_type=code&client_id=mcp-connector&redirect_uri=http://localhost:8847/callback&scope=mcp:tools"
```

**2. Authentication Failures**
```bash
# Check Supabase credentials in .env
# Verify database tables exist
# Check server logs for errors
npm start
```

**3. Connection Issues**
```bash
# Test SSE connection manually
curl -H "Authorization: Bearer your-token" http://localhost:3007/sse

# Expected: SSE stream or 401 Unauthorized
```

**4. Database Setup Issues**
```bash
# Re-run setup and copy SQL to Supabase
npm run setup

# Check if tables exist in Supabase dashboard
```

### Debugging Tips

- **Check server logs** - Run `npm start` and watch output
- **Verify environment** - Ensure .env file has correct Supabase credentials
- **Test OAuth manually** - Use browser to test OAuth flow
- **Check Claude Desktop logs** - Look for MCP connection errors

## Production Deployment

### HTTPS Setup
- Deploy server with SSL certificates
- Update `MCP_SERVER_URL` to https://your-domain.com
- Configure Supabase for production domain

### Environment Variables
```bash
# Production environment
NODE_ENV=production
MCP_SERVER_PORT=3007
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-production-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-production-service-key
```

### Scaling Considerations
- **Load Balancing** - Multiple server instances
- **Database Optimization** - Connection pooling
- **Monitoring** - Health checks and metrics
- **Backup Strategy** - Regular database backups

## Summary

The Supabase MCP Server provides a complete remote MCP solution with:

✅ **Automatic OAuth Flow** - No manual token management  
✅ **SSE Transport** - Real-time bidirectional communication  
✅ **Secure Authentication** - Supabase-powered with JWT tokens  
✅ **User-Scoped Tools** - Safe, isolated tool execution  
✅ **Session Management** - Persistent, expiring sessions  
✅ **Production Ready** - HTTPS, rate limiting, monitoring

Simply add the configuration to Claude Desktop and the OAuth flow handles everything automatically!