# Remote MCP MVP - Simplified Implementation Plan

## Overview

This is a simplified MVP version focused on delivering Remote MCP functionality quickly with minimal complexity. The goal is a single-device solution with OAuth authentication.

## Simplified Architecture

```mermaid
graph TB
    A[Claude Desktop] -->|HTTPS MCP| B[Remote MCP Server]
    B -->|OAuth| C[Ory Kratos/Hydra]
    B -->|WebSocket| D[Desktop Commander Agent]
    B -->|SQL| E[PostgreSQL]
    
    D -->|Local MCP| F[Local Machine]
```

## Three Simple Components

### 1. Claude Desktop (MCP Client)
- Points to `https://mcp.yourserver.com`
- OAuth 2.0 login via browser redirect
- Standard MCP requests over HTTPS

### 2. Remote MCP Server (Simple Backend)
- **Technology**: Node.js + Express + WebSocket
- **Authentication**: Ory Kratos/Hydra OAuth
- **Database**: PostgreSQL (users, devices, sessions)
- **Communication**: Direct WebSocket to single device
- **No queues, no complex routing, no scopes**

### 3. Desktop Commander Agent (Local Machine)
- Enhanced Desktop Commander with WebSocket connection
- Connects to cloud server with device token
- Executes MCP requests locally
- Simple request/response flow

## Simplified Features

### What's INCLUDED ✅
- OAuth login (Google/GitHub)
- Single device registration
- All existing MCP tools work remotely
- WebSocket real-time communication
- Basic error handling
- Simple web dashboard

### What's REMOVED ❌
- ~~Multi-device support~~
- ~~Scopes and permissions~~
- ~~Message queues~~
- ~~Complex aggregation~~
- ~~Enterprise features~~
- ~~Advanced monitoring~~
- ~~Load balancing~~

## Database Schema (Simple)

```sql
-- users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    provider VARCHAR(50), -- 'google', 'github'
    provider_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- devices table  
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'offline', -- 'online', 'offline'
    last_seen TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    device_id UUID REFERENCES devices(id),
    token_hash VARCHAR(255),
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## API Endpoints (Minimal)

```typescript
// Authentication
POST /auth/login          // Start OAuth flow
GET  /auth/callback       // OAuth callback
POST /auth/logout         // Logout

// Device management
GET  /api/device          // Get user's device
POST /api/device/register // Register device
PUT  /api/device/status   // Update device status

// MCP execution
POST /api/mcp/execute     // Execute MCP request

// WebSocket
WS   /ws/device          // Device connection
```

## Implementation Steps

### Week 1: Basic Setup
1. Setup Ory Kratos/Hydra with Google OAuth
2. Create simple Express server
3. Basic PostgreSQL schema
4. OAuth login flow working

### Week 2: Device Registration
1. Device registration API
2. WebSocket server setup
3. Basic device connection
4. Device status tracking

### Week 3: MCP Integration
1. Extend Desktop Commander with WebSocket client
2. MCP request forwarding
3. Basic error handling
4. End-to-end test with one MCP tool

### Week 4: Polish & Deploy
1. Simple web dashboard
2. Error handling improvements
3. Basic deployment setup
4. Testing and fixes

## Minimal Infrastructure

### Development
```yaml
# docker-compose.yml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: remotemcp
      POSTGRES_PASSWORD: password

  kratos:
    image: oryd/kratos:latest
    environment:
      DSN: postgres://postgres:password@postgres:5432/remotemcp

  hydra:
    image: oryd/hydra:latest  
    environment:
      DSN: postgres://postgres:password@postgres:5432/remotemcp

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://postgres:password@postgres:5432/remotemcp
```

### Production (Simple VPS)
- **Server**: $20/month VPS (2GB RAM, 1 CPU)
- **Database**: PostgreSQL on same VPS
- **Domain**: Custom domain with SSL
- **Deployment**: Docker Compose
- **Monitoring**: Basic logs + uptime check

## Code Structure (Minimal)

```
remote-mcp-server/
├── src/
│   ├── auth/           # OAuth handling
│   ├── device/         # Device management  
│   ├── mcp/           # MCP request handling
│   ├── websocket/     # WebSocket server
│   └── server.ts      # Main server
├── migrations/        # DB migrations
├── docker-compose.yml
└── package.json

desktop-commander-remote/
├── src/
│   ├── remote-client.ts    # WebSocket client
│   ├── auth-manager.ts     # Device authentication
│   └── main.ts            # Enhanced Desktop Commander
└── package.json
```

## Simple Authentication Flow

1. **User Setup**:
   - User visits `https://mcp.yourserver.com`
   - Clicks "Login with Google"
   - OAuth flow completes
   - Gets access token

2. **Device Registration**:
   - User clicks "Add Device"
   - Gets device registration code
   - Installs enhanced Desktop Commander
   - Agent connects with device code

3. **MCP Usage**:
   - Claude Desktop makes MCP request to cloud server
   - Server validates user token
   - Server forwards request via WebSocket to device
   - Device executes locally and returns result
   - Server returns result to Claude

## MVP Success Criteria

- ✅ User can login with Google/GitHub
- ✅ User can register one device
- ✅ All existing Desktop Commander MCP tools work remotely
- ✅ Latency under 3 seconds for typical operations
- ✅ Simple web interface to manage device
- ✅ Basic error handling and recovery

## Next Phase (Post-MVP)
- Multiple devices per user
- Better error handling and retry logic
- Performance optimization
- Enhanced security features
- Mobile agent support

This MVP approach gets you a fully functional Remote MCP system in 4 weeks with minimal complexity and infrastructure costs.