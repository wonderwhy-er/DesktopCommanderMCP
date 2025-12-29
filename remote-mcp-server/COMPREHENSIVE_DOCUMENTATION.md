# Remote MCP Server - Comprehensive Documentation

**Version**: 2.0.0  
**Last Updated**: December 25, 2025  
**Status**: Production Ready  

## 📋 Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Diagrams](#architecture-diagrams)
3. [Component Details](#component-details)
4. [Workflow Diagrams](#workflow-diagrams)
5. [OAuth Integration](#oauth-integration)
6. [Ory Hydra/Kratos Integration](#ory-hydrakratos-integration)
7. [Deployment Guide](#deployment-guide)
8. [Troubleshooting](#troubleshooting)
9. [Security Considerations](#security-considerations)
10. [API Reference](#api-reference)

---

## 🔭 System Overview

The Remote MCP Server system enables secure, authenticated remote control of machines through Claude Desktop using the Model Context Protocol (MCP) with OAuth 2.1 authentication. The system supports multiple integration patterns and authentication mechanisms.

### Core Components

1. **Remote MCP Server** - Main HTTP server with SSE transport
2. **OAuth Authorization Server** - Standards-compliant OAuth 2.1 provider
3. **Local MCP Agent** - Runs on target machines for command execution
4. **Desktop Commander Integration** - File system and process control
5. **Ory Hydra/Kratos** - Production OAuth infrastructure (optional)

### Key Features

- ✅ **MCP Authorization Specification Compliant**
- ✅ **OAuth 2.1 with PKCE Support**
- ✅ **Multi-transport Support** (SSE, HTTP, stdio)
- ✅ **Production-ready Monitoring**
- ✅ **Comprehensive Security**
- ✅ **Multi-user Support**

---

## 🏗 Architecture Diagrams

### High-Level System Architecture

```
┌─────────────────┐    OAuth 2.1    ┌─────────────────────┐
│                 │◄────────────────►│                     │
│  Claude Desktop │                  │ OAuth Auth Server   │
│                 │                  │ (Port 4448)         │
└─────────┬───────┘                  └─────────────────────┘
          │                                     │
          │ MCP + Bearer Token                  │
          │                                     │
          ▼                                     ▼
┌─────────────────┐    SSE/HTTP     ┌─────────────────────┐
│                 │◄────────────────►│                     │
│ MCP Resource    │                  │ Remote MCP Server   │
│ Server          │                  │ (Port 3005)         │
│ (Spec Compliant)│                  │                     │
└─────────┬───────┘                  └─────────┬───────────┘
          │                                     │
          │ Authenticated Commands              │
          │                                     │
          ▼                                     ▼
┌─────────────────┐    Device Token  ┌─────────────────────┐
│                 │◄────────────────►│                     │
│ Local MCP Agent │                  │ Desktop Commander   │
│ (Target Machine)│                  │ MCP Tools           │
└─────────────────┘                  └─────────────────────┘
```

### Component Interaction Flow

```
┌─────────────┐
│ User Action │
└──────┬──────┘
       │
       ▼
┌─────────────┐     1. OAuth Flow      ┌─────────────────┐
│             │◄──────────────────────►│                 │
│ Claude      │     2. Get Token       │ OAuth Server    │
│ Desktop     │◄──────────────────────►│ (Hydra/Demo)    │
└──────┬──────┘                        └─────────────────┘
       │
       │ 3. MCP Request + Bearer Token
       ▼
┌─────────────┐     4. Validate Token  ┌─────────────────┐
│             │◄──────────────────────►│                 │
│ MCP Server  │     5. Token OK        │ OAuth Server    │
│ (Port 3005) │◄──────────────────────►│ (Introspection) │
└──────┬──────┘                        └─────────────────┘
       │
       │ 6. Execute Command
       ▼
┌─────────────┐     7. SSE/HTTP        ┌─────────────────┐
│             │◄──────────────────────►│                 │
│ Local Agent │     8. File System     │ Target Machine  │
│             │     Operations         │ Resources       │
└─────────────┘                        └─────────────────┘
```

---

## 🧩 Component Details

### 1. MCP Resource Server (Port 3005)

**File**: `mcp-server-spec-compliant.js`

**Purpose**: Main MCP server implementing the official MCP Authorization Specification

**Key Features**:
- HTTP transport with Server-Sent Events (SSE)
- Bearer token authentication
- WWW-Authenticate header discovery
- Token introspection integration
- Comprehensive logging and monitoring

**Endpoints**:
- `GET /sse` - SSE connection for MCP communication (auth required)
- `POST /message` - Alternative message endpoint (auth required)
- `GET /health` - Server health and configuration status
- `OPTIONS /*` - CORS preflight support

### 2. OAuth Authorization Server (Port 4448)

**File**: Built-in demo provider from MCP SDK

**Purpose**: Standards-compliant OAuth 2.1 authorization server

**Key Features**:
- Dynamic client registration (RFC 7591)
- Authorization code flow with PKCE (RFC 7636)
- Token introspection (RFC 7662)
- OAuth server metadata (RFC 8414)
- Protected resource metadata (RFC 9728)

**Endpoints**:
- `GET /authorize` - OAuth authorization endpoint
- `POST /token` - Token exchange endpoint
- `POST /register` - Dynamic client registration
- `POST /introspect` - Token introspection
- `GET /.well-known/oauth-authorization-server` - Server metadata

### 3. Remote MCP Server (Port 3002/3003)

**Files**: `src/server.ts`, `mcp-server.js`

**Purpose**: Traditional SSE-based remote server with JWT authentication

**Key Features**:
- Express.js HTTP server
- PostgreSQL database integration
- JWT device token authentication
- Real-time SSE communication
- Web dashboard interface

### 4. Local MCP Agent

**File**: `agent.js`

**Purpose**: Runs on target machines to execute Desktop Commander tools

**Key Features**:
- SSE connection to remote server
- JWT token authentication
- File system operations
- Process execution and management
- Real-time bidirectional communication

### 5. Monitoring Infrastructure

**Files**: `monitor-mcp-server.js`, `test-full-oauth-flow.js`

**Purpose**: Comprehensive monitoring, logging, and testing

**Key Features**:
- Real-time process monitoring
- Structured JSON logging
- Automatic restart on failures
- Complete OAuth flow testing
- System resource tracking

---

## 📊 Workflow Diagrams

### OAuth 2.1 Authentication Flow

```
┌─────────────┐                                    ┌─────────────┐
│             │  1. Register Client                │             │
│   Client    │───────────────────────────────────►│OAuth Server │
│             │◄───────────────────────────────────│             │
└─────────────┘  2. Client ID + Secret            └─────────────┘
       │                                                    ▲
       │                                                    │
       │ 3. Generate PKCE                                   │
       │    Code Challenge                                  │
       │                                                    │
       ▼                                                    │
┌─────────────┐  4. Authorization Request          ┌─────────────┐
│             │───────────────────────────────────►│             │
│   Client    │     + Code Challenge               │OAuth Server │
│             │◄───────────────────────────────────│             │
└─────────────┘  5. Redirect with Auth Code       └─────────────┘
       │                                                    ▲
       │                                                    │
       │ 6. Extract Auth Code                               │
       │                                                    │
       ▼                                                    │
┌─────────────┐  7. Token Exchange Request          ┌─────────────┐
│             │───────────────────────────────────►│             │
│   Client    │     + Code Verifier                │OAuth Server │
│             │◄───────────────────────────────────│             │
└─────────────┘  8. Access Token                   └─────────────┘
```

### MCP Communication Flow

```
┌─────────────┐                                    ┌─────────────┐
│             │  1. SSE Connection Request         │             │
│   Client    │───────────────────────────────────►│MCP Server   │
│             │     + Bearer Token                 │             │
└─────────────┘                                    └──────┬──────┘
       ▲                                                  │
       │                                                  │
       │                                                  │ 2. Validate
       │                                                  │    Token
       │                                                  │
       │                                                  ▼
┌─────────────┐  3. Token Introspection            ┌─────────────┐
│             │◄───────────────────────────────────│             │
│OAuth Server │───────────────────────────────────►│MCP Server   │
│             │  4. Token Valid Response           │             │
└─────────────┘                                    └──────┬──────┘
                                                          │
                                                          │ 5. Establish
                                                          │    SSE Stream
                                                          │
                                                          ▼
┌─────────────┐  6. SSE Stream Established         ┌─────────────┐
│             │◄───────────────────────────────────│             │
│   Client    │                                    │MCP Server   │
│             │  7. MCP Messages                   │             │
│             │◄──────────────────────────────────►│             │
└─────────────┘                                    └─────────────┘
```

### Remote Command Execution Flow

```
┌─────────────┐                                    ┌─────────────┐
│             │  1. MCP Tool Call Request          │             │
│   Client    │───────────────────────────────────►│MCP Server   │
│ (Authenticated)                                  │             │
└─────────────┘                                    └──────┬──────┘
                                                          │
                                                          │ 2. Validate
                                                          │    Request
                                                          │
                                                          ▼
┌─────────────┐  3. Forward Command                ┌─────────────┐
│             │◄───────────────────────────────────│             │
│Local Agent  │    + Device Token                  │MCP Server   │
│             │───────────────────────────────────►│             │
└──────┬──────┘  4. Command Response               └─────────────┘
       │                                                  ▲
       │                                                  │
       │ 5. Execute on                                    │
       │    Target Machine                                │
       │                                                  │
       ▼                                                  │
┌─────────────┐  6. Operation Result                ┌─────────────┐
│             │───────────────────────────────────►│             │
│Desktop      │                                    │Local Agent  │
│Commander    │◄───────────────────────────────────│             │
│             │  7. File System Response           │             │
└─────────────┘                                    └─────────────┘
```

---

## 🔐 OAuth Integration

### OAuth 2.1 Implementation Details

The system implements OAuth 2.1 with the following specifications:

#### Supported Grant Types
- **Authorization Code**: Primary flow for web applications
- **PKCE (RFC 7636)**: Required for public clients and recommended for all
- **Refresh Token**: For long-lived access (when implemented)

#### Security Features
- **State Parameter**: CSRF protection
- **Code Challenge**: PKCE for additional security
- **Token Introspection**: Real-time token validation
- **Short-lived Tokens**: 1-hour access token lifetime
- **Secure Storage**: Tokens stored in memory (demo) or database (production)

### OAuth Endpoints Configuration

```javascript
{
  "issuer": "http://localhost:4448/",
  "authorization_endpoint": "http://localhost:4448/authorize",
  "token_endpoint": "http://localhost:4448/token",
  "introspection_endpoint": "http://localhost:4448/introspect",
  "registration_endpoint": "http://localhost:4448/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["mcp:tools", "mcp:remote"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "none"]
}
```

### Client Registration Process

1. **Dynamic Registration**: Clients can self-register using RFC 7591
2. **Client Credentials**: Receive client_id and client_secret
3. **Scope Assignment**: Automatic assignment of appropriate scopes
4. **Redirect URI Validation**: Strict validation of redirect URIs

---

## 🏛 Ory Hydra/Kratos Integration

### Production OAuth Infrastructure

For production deployments, the system integrates with Ory Hydra (OAuth server) and Ory Kratos (identity management).

#### Architecture with Ory Stack

```
┌─────────────┐    OIDC/OAuth    ┌─────────────────┐
│             │◄───────────────►│                 │
│Claude Desktop│                 │  Ory Hydra     │
│             │                 │ (OAuth Server)  │
└─────────────┘                 └─────────┬───────┘
       │                                  │
       │ MCP + Token                      │ Identity
       │                                  │ Verification
       ▼                                  ▼
┌─────────────┐    Token         ┌─────────────────┐
│             │  Introspection   │                 │
│MCP Server   │◄───────────────►│  Ory Kratos     │
│             │                 │ (Identity Mgmt) │
└─────────────┘                 └─────────────────┘
```

#### Ory Hydra Configuration

**File**: `docker-compose.oauth.yml`

```yaml
services:
  hydra:
    image: oryd/hydra:v2.2.0
    environment:
      - DSN=postgresql://hydra:secret@postgres:5432/hydra?sslmode=disable
      - URLS_SELF_ISSUER=http://localhost:4444
      - URLS_CONSENT=http://localhost:3003/auth/consent
      - URLS_LOGIN=http://localhost:3003/auth/login-challenge
      - URLS_LOGOUT=http://localhost:3003/auth/logout
    ports:
      - "4444:4444"
      - "4445:4445"
```

#### Ory Kratos Configuration

**File**: `kratos/kratos.yml`

```yaml
version: v1.1.0

dsn: postgresql://kratos:secret@postgres:5432/kratos?sslmode=disable

serve:
  public:
    base_url: http://localhost:4433/
    cors:
      enabled: true
  admin:
    base_url: http://localhost:4434/

selfservice:
  default_browser_return_url: http://localhost:3003/
  allowed_return_urls:
    - http://localhost:3003
    - http://localhost:3003/auth/callback

identity:
  default_schema_id: default
  schemas:
    - id: default
      url: file:///etc/config/kratos/identity.schema.json
```

### Production OAuth Flow

1. **User Registration**: Managed by Ory Kratos
2. **Authentication**: Secure login flow through Kratos
3. **Authorization**: OAuth consent managed by Hydra
4. **Token Issuance**: JWT or opaque tokens from Hydra
5. **Token Validation**: Introspection endpoint for MCP server

### Database Schema

#### Kratos Tables
- `identities` - User identity records
- `identity_credentials` - Authentication credentials
- `sessions` - User session management
- `verification_tokens` - Email verification

#### Hydra Tables
- `hydra_oauth2_authentication_session`
- `hydra_oauth2_consent_session`
- `hydra_oauth2_access`
- `hydra_oauth2_refresh`
- `hydra_oauth2_code`

---

## 🚀 Deployment Guide

### Development Deployment

#### Option 1: OAuth Specification Compliant (Recommended)

```bash
# 1. Install dependencies
cd remote-mcp-server
npm install

# 2. Start with monitoring
node monitor-mcp-server.js

# Servers will start on:
# - MCP Resource Server: http://localhost:3005
# - OAuth Authorization Server: http://localhost:4448
```

#### Option 2: Traditional SSE with JWT

```bash
# 1. Start PostgreSQL database
docker-compose up -d postgres

# 2. Start the main server
npm run dev

# 3. On target machines, start agents
node agent.js "http://localhost:3002" "YOUR_DEVICE_TOKEN"
```

### Production Deployment

#### Option 1: Docker Compose with Ory Stack

```bash
# 1. Start Ory infrastructure
docker-compose -f docker-compose.oauth.yml up -d

# 2. Initialize Hydra client
./setup-oauth-client.sh

# 3. Start MCP server
NODE_ENV=production node mcp-server-spec-compliant.js
```

#### Option 2: Kubernetes Deployment

```yaml
# mcp-server-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mcp-server
  template:
    metadata:
      labels:
        app: mcp-server
    spec:
      containers:
      - name: mcp-server
        image: remote-mcp-server:latest
        ports:
        - containerPort: 3005
        env:
        - name: OAUTH_AUTH_SERVER
          value: "https://oauth.yourcompany.com"
        - name: DATABASE_URL
          value: "postgresql://user:pass@postgres:5432/mcpdb"
```

### Environment Variables

```bash
# MCP Server Configuration
MCP_SERVER_PORT=3005
OAUTH_AUTH_PORT=4448

# OAuth Configuration
OAUTH_ISSUER_URL=http://localhost:4448
OAUTH_CLIENT_ID=remote-mcp-client
OAUTH_SCOPE="mcp:tools mcp:remote"

# Database Configuration (for traditional server)
DATABASE_URL=postgresql://user:pass@localhost:5432/mcpdb
POSTGRES_USER=mcpuser
POSTGRES_PASSWORD=mcppass
POSTGRES_DB=mcp_remote_server

# Ory Configuration (production)
HYDRA_ADMIN_URL=http://localhost:4445
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434

# Security
JWT_SECRET=your-super-secret-jwt-key
SESSION_SECRET=your-session-secret-key
ENCRYPTION_KEY=your-32-character-encryption-key

# Monitoring
LOG_LEVEL=info
ENABLE_METRICS=true
METRICS_PORT=9090
```

---

## 🔧 Troubleshooting

### Common Issues and Solutions

#### 1. Server Exits with Code 137

**Issue**: Process killed unexpectedly
**Cause**: Port conflicts or resource constraints
**Solution**:
```bash
# Check port usage
lsof -i :3005
lsof -i :4448

# Kill conflicting processes
kill -9 $(lsof -ti :3005)
kill -9 $(lsof -ti :4448)

# Start with monitoring
node monitor-mcp-server.js
```

#### 2. OAuth Authentication Failures

**Issue**: "invalid_client" or "invalid_state" errors
**Cause**: Client configuration or state parameter issues
**Solution**:
```bash
# Test OAuth flow
node test-full-oauth-flow.js

# Check OAuth server metadata
curl http://localhost:4448/.well-known/oauth-authorization-server | jq .

# Verify client registration
curl -X POST http://localhost:4448/register \
  -H "Content-Type: application/json" \
  -d '{"client_name": "test", "redirect_uris": ["http://localhost:8080/callback"]}'
```

#### 3. SSE Connection Issues

**Issue**: SSE connections fail or hang
**Cause**: Authentication or network issues
**Solution**:
```bash
# Test health endpoint
curl http://localhost:3005/health

# Test authentication
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3005/sse

# Check logs
tail -f logs/mcp-oauth-server-*.log
```

#### 4. Database Connection Errors

**Issue**: PostgreSQL connection failures
**Cause**: Database not running or wrong credentials
**Solution**:
```bash
# Start database
docker-compose up -d postgres

# Test connection
psql postgresql://mcpuser:mcppass@localhost:5432/mcp_remote_server

# Check environment variables
echo $DATABASE_URL
```

### Debugging Tools

#### 1. Log Analysis

```bash
# Real-time log monitoring
tail -f logs/mcp-oauth-server-*.log | jq .

# Search for errors
grep -r "ERROR" logs/ | jq .

# Filter by level
jq 'select(.level == "ERROR")' logs/mcp-oauth-server-*.log
```

#### 2. Health Checks

```bash
# MCP server health
curl http://localhost:3005/health | jq .

# OAuth server health
curl http://localhost:4448/.well-known/oauth-authorization-server | jq .

# Database health
psql $DATABASE_URL -c "SELECT NOW();"
```

#### 3. Performance Monitoring

```bash
# Process monitoring
ps aux | grep node

# Memory usage
free -h

# Network connections
netstat -tulpn | grep :3005
```

---

## 🛡 Security Considerations

### Authentication Security

1. **OAuth 2.1 Compliance**: Implements latest OAuth security practices
2. **PKCE Required**: Proof Key for Code Exchange prevents code injection
3. **Short-lived Tokens**: 1-hour access token lifetime
4. **Secure Token Storage**: Tokens stored securely, never logged
5. **State Parameter**: CSRF protection for authorization requests

### Transport Security

1. **HTTPS in Production**: All communication over TLS
2. **CORS Configuration**: Restricted cross-origin access
3. **Token Transmission**: Bearer tokens in Authorization headers only
4. **SSE Security**: Authenticated Server-Sent Event streams

### Infrastructure Security

1. **Database Encryption**: Sensitive data encrypted at rest
2. **Environment Variables**: Secrets stored in environment, not code
3. **Process Isolation**: Containers and separate processes
4. **Network Segmentation**: Restricted network access between components

### Monitoring and Auditing

1. **Comprehensive Logging**: All authentication attempts logged
2. **Token Introspection**: Real-time token validation
3. **Failed Login Tracking**: Brute force protection
4. **Audit Trails**: Complete request/response logging

### Production Security Checklist

- [ ] Use HTTPS certificates from trusted CA
- [ ] Enable database encryption
- [ ] Configure firewall rules
- [ ] Set up log monitoring and alerting
- [ ] Implement rate limiting
- [ ] Use strong, unique secrets
- [ ] Regular security updates
- [ ] Backup and disaster recovery
- [ ] Network segmentation
- [ ] Access control and RBAC

---

## 📚 API Reference

### MCP Resource Server API

#### Authentication
All endpoints except `/health` require Bearer token authentication:
```
Authorization: Bearer <access_token>
```

#### Endpoints

##### GET /health
**Description**: Server health and configuration status
**Authentication**: Not required
**Response**:
```json
{
  "status": "ok",
  "server": "remote-mcp-server-spec-compliant",
  "oauth": {
    "issuer": "http://localhost:4448/",
    "authorization_endpoint": "http://localhost:4448/authorize",
    "token_endpoint": "http://localhost:4448/token",
    "scopes_supported": ["mcp:tools"]
  },
  "endpoints": {
    "sse": "http://localhost:3005/sse",
    "message": "http://localhost:3005/message"
  },
  "timestamp": "2025-12-25T09:23:38.823Z"
}
```

##### GET /sse
**Description**: Establish SSE connection for MCP communication
**Authentication**: Required (Bearer token)
**Headers**:
```
Accept: text/event-stream
Authorization: Bearer <access_token>
```
**Response**: SSE stream with MCP messages

##### POST /message
**Description**: Send MCP messages (alternative to SSE)
**Authentication**: Required (Bearer token)
**Request Body**: MCP JSON-RPC message
**Response**: MCP JSON-RPC response

### OAuth Authorization Server API

#### POST /register
**Description**: Dynamic client registration (RFC 7591)
**Request Body**:
```json
{
  "client_name": "My MCP Client",
  "redirect_uris": ["http://localhost:8080/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "scope": "mcp:tools"
}
```
**Response**:
```json
{
  "client_id": "generated-client-id",
  "client_secret": "generated-client-secret",
  "client_secret_expires_at": 1769246681,
  "client_id_issued_at": 1766654681,
  "redirect_uris": ["http://localhost:8080/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "scope": "mcp:tools"
}
```

#### GET /authorize
**Description**: OAuth authorization endpoint
**Query Parameters**:
- `response_type=code` (required)
- `client_id` (required)
- `redirect_uri` (required)
- `scope` (optional)
- `state` (recommended)
- `code_challenge` (required for PKCE)
- `code_challenge_method=S256` (required)
- `resource` (optional, for resource indicator)

**Response**: HTTP 302 redirect to redirect_uri with authorization code

#### POST /token
**Description**: Token exchange endpoint
**Request Body** (application/x-www-form-urlencoded):
```
grant_type=authorization_code
&code=<authorization_code>
&redirect_uri=<redirect_uri>
&client_id=<client_id>
&client_secret=<client_secret>
&code_verifier=<code_verifier>
```
**Response**:
```json
{
  "access_token": "generated-access-token",
  "token_type": "bearer",
  "expires_in": 3600,
  "scope": "mcp:tools"
}
```

#### POST /introspect
**Description**: Token introspection endpoint (RFC 7662)
**Request Body** (application/x-www-form-urlencoded):
```
token=<access_token>
```
**Response**:
```json
{
  "active": true,
  "client_id": "client-id",
  "scope": "mcp:tools",
  "exp": 1766658281,
  "aud": "http://localhost:3005/"
}
```

### MCP Protocol Messages

#### Initialize Request
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "clientInfo": {
      "name": "client-name",
      "version": "1.0.0"
    }
  }
}
```

#### List Tools Request
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

#### Call Tool Request
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": {
      "path": "/etc/hosts"
    }
  }
}
```

### Desktop Commander Tools

The system supports all Desktop Commander MCP tools:

- `read_file` - Read file contents
- `write_file` - Write/append to files
- `list_directory` - List directory contents
- `create_directory` - Create directories
- `move_file` - Move/rename files
- `get_file_info` - Get file metadata
- `start_process` - Execute commands
- `interact_with_process` - Send input to processes
- `read_process_output` - Read process output
- `force_terminate` - Terminate processes
- `list_sessions` - List active sessions
- `start_search` - Start file search
- `get_more_search_results` - Get search results
- `stop_search` - Stop active search
- `edit_block` - Edit file blocks

---

## 📊 Conclusion

This comprehensive documentation covers all aspects of the Remote MCP Server system, from basic setup to production deployment with OAuth authentication. The system provides multiple integration patterns to suit different use cases, from simple JWT-based authentication to full OAuth 2.1 compliance with Ory infrastructure.

For additional support or questions, refer to the troubleshooting section or check the comprehensive logs generated by the monitoring system.

**Version**: 2.0.0 - Production Ready with OAuth 2.1 Compliance