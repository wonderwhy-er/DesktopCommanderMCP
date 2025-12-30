# Architecture Guide

This document provides a comprehensive overview of the Supabase MCP Server architecture, including system design, data flows, and implementation details.

## 🏗️ System Overview

The Supabase MCP Server is a distributed system that enables remote tool execution through real-time communication channels. It bridges Claude Desktop with remote agents, providing a secure and scalable platform for distributed AI workflows.

### High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Claude Desktop │────►│ Supabase MCP    │────►│  Remote Agent   │
│                 │     │ Server          │     │  (Machine A)    │
│  - MCP Client   │◄────│                 │◄────│                 │
│  - Tool Calls   │     │ ┌─────────────┐ │     │ - Tool Executor │
│  - UI           │     │ │ Channel     │ │     │ - Desktop Int.  │
└─────────────────┘     │ │ Manager     │ │     │ - OAuth Client  │
                        │ └─────────────┘ │     └─────────────────┘
┌─────────────────┐     │ ┌─────────────┐ │     ┌─────────────────┐
│                 │     │ │ Tool        │ │     │                 │
│  Web Browser    │────►│ │ Dispatcher  │ │────►│  Remote Agent   │
│                 │     │ └─────────────┘ │     │  (Machine B)    │
│ - OAuth Flow    │◄────│ ┌─────────────┐ │◄────│                 │
│ - Auth UI       │     │ │ Agent       │ │     │ - Headless Mode │
└─────────────────┘     │ │ Registry    │ │     │ - Tool Executor │
                        │ └─────────────┘ │     │ - SSH/Docker    │
        ┌───────────────┤ ┌─────────────┐ │     └─────────────────┘
        │               │ │ OAuth       │ │
        │               │ │ Provider    │ │
        ▼               │ └─────────────┘ │
┌─────────────────┐     └─────────────────┘
│                 │              │
│   Supabase      │◄─────────────┘
│                 │
│ - PostgreSQL    │
│ - Real-time     │
│ - Auth          │
│ - Row Security  │
└─────────────────┘
```

## 🔧 Core Components

### 1. Base MCP Server (`src/server/mcp-server.js`)

The central server that handles MCP protocol communication with Claude Desktop.

**Responsibilities:**
- MCP protocol compliance and message routing
- HTTP/HTTPS server with Express.js
- Session management and transport creation
- Authentication middleware integration
- Tool registration and execution coordination

**Key Features:**
- SDK-based MCP implementation using `@modelcontextprotocol/sdk`
- Session-based transport management
- Automatic user channel subscription
- Graceful shutdown handling

### 2. Channel Manager (`src/remote/channel-manager.js`)

Manages Supabase real-time channels for communication between server and agents.

**Responsibilities:**
- User-specific channel subscriptions (`mcp_user_{userId}`)
- Tool call broadcasting to agents
- Tool result collection from agents
- Presence tracking for connected agents
- Channel lifecycle management

**Communication Flow:**
```
Server → Channel Manager → Supabase Channel → Remote Agent
       ←                ←                  ←
```

### 3. Tool Dispatcher (`src/remote/tool-dispatcher.js`)

Orchestrates tool calls between the server and remote agents.

**Responsibilities:**
- Tool call queue management with timeout handling
- Agent availability checking
- Database persistence of call status
- Promise-based result handling
- Periodic cleanup of stale calls

**State Machine:**
```
pending → executing → completed/failed
   ↓         ↓            ↓
database  database   database
 insert   update     update
```

### 4. Agent Registry (`src/remote/agent-registry.js`)

Tracks and manages connected remote agents.

**Responsibilities:**
- Agent registration with capability reporting
- Status tracking and last-seen updates
- Available agent discovery
- Cleanup of offline agents

**Agent Lifecycle:**
```
Registration → Online → Heartbeat → Offline → Cleanup
     ↓           ↓         ↓          ↓         ↓
   Database   Database  Database  Database  Database
   INSERT     UPDATE    UPDATE    UPDATE    DELETE
```

### 5. Remote Agent (`agent.js`)

Standalone agent that connects to the server and executes tools.

**Responsibilities:**
- OAuth authentication (desktop/headless modes)
- Supabase client configuration
- Real-time channel subscription
- Tool execution via Desktop Integration
- Presence tracking and heartbeat

**Agent States:**
- **Initializing**: Starting up and configuring
- **Authenticating**: Completing OAuth flow
- **Registering**: Adding to server registry
- **Online**: Ready to receive tool calls
- **Executing**: Processing a tool call
- **Shutting Down**: Graceful disconnection

## 🔄 Data Flow Diagrams

### Tool Execution Flow

```
1. Tool Request
Claude Desktop ──MCP Request──► Base MCP Server
                                      │
2. Dispatch                          │
                                     ▼
                            Tool Dispatcher
                                     │
3. Find Agent                        │
                                     ▼
                            Agent Registry ──Query──► Database
                                     │                    │
4. Queue Call                        │                    ▼
                                     ▼              mcp_remote_calls
                              Channel Manager           (INSERT)
                                     │
5. Broadcast                         │
                                     ▼
                            Supabase Channel
                                     │
6. Receive                           │
                                     ▼
                              Remote Agent
                                     │
7. Execute                           │
                                     ▼
                           Desktop Integration
                                     │
8. Result                            │
                                     ▼
                            Supabase Channel
                                     │
9. Handle Result                     │
                                     ▼
                           Tool Dispatcher ──Update──► Database
                                     │                     │
10. Response                         │                     ▼
                                     ▼               mcp_remote_calls
                            Base MCP Server           (UPDATE)
                                     │
11. MCP Response                     │
                                     ▼
Claude Desktop ◄──MCP Response───── Base MCP Server
```

### Authentication Flow

```
1. Agent Start
Remote Agent ──HTTP Request──► Base MCP Server
                                      │
2. OAuth URL                          │
                                      ▼
Remote Agent ◄──OAuth URL──── OAuth Provider
      │                              │
3. Browser/Manual                     │
      ▼                              │
Web Browser ──Login/Signup──► Supabase Auth
                                      │
4. Callback                           │
                                      ▼
Base MCP Server ◄──Access Token───── OAuth Provider
                                      │
5. Token Response                     │
                                      ▼
Remote Agent ◄──Access Token──── Base MCP Server
      │
6. Client Config
      ▼
Supabase Client ──Get User──► Supabase Auth
      │                           │
7. Agent Registration              │
      ▼                           ▼
Agent Registry ──Insert──► Database (mcp_agents)
```

## 💾 Database Schema

### Entity Relationship Diagram

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  mcp_pkce_codes │     │   mcp_agents    │     │mcp_remote_calls │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ id (PK)         │     │ id (PK)         │     │ id (PK)         │
│ authorization_id│     │ user_id (FK)    │     │ user_id (FK)    │
│ code_challenge  │     │ agent_name      │     │ agent_id (FK)   │
│ redirect_uri    │     │ machine_id      │     │ tool_name       │
│ expires_at      │     │ capabilities    │     │ tool_args       │
│ created_at      │     │ status          │     │ status          │
└─────────────────┘     │ last_seen       │     │ result          │
                        │ auth_token      │     │ error_message   │
                        │ created_at      │     │ created_at      │
                        │ updated_at      │     │ completed_at    │
                        └─────────────────┘     │ timeout_at      │
                                 │              └─────────────────┘
                                 │                       │
                                 └───────────────────────┘
```

### Table Purposes

1. **mcp_pkce_codes**: OAuth PKCE code storage for secure authentication
2. **mcp_agents**: Registry of connected agents with capabilities and status
3. **mcp_remote_calls**: Tool call queue and execution tracking

### Row Level Security (RLS)

All tables implement user-scoped access:

```sql
-- Users can only access their own data
CREATE POLICY "User isolation" ON table_name 
FOR ALL USING (auth.uid() = user_id);

-- Exception: PKCE codes are temporarily public for auth flow
CREATE POLICY "PKCE public access" ON mcp_pkce_codes 
FOR ALL USING (true);
```

## 🔐 Security Architecture

### Authentication Chain

```
1. Agent OAuth ──► Supabase Auth ──► JWT Token
                        │               │
2. JWT Validation ◄─────┘               │
                                        │
3. User Context ◄───────────────────────┘
                        │
4. RLS Enforcement ◄────┘
                        │
5. Tool Execution ◄─────┘
```

### Security Layers

1. **Network Layer**: HTTPS/WSS encryption for all communication
2. **Authentication Layer**: OAuth 2.0 with PKCE for secure agent authentication
3. **Authorization Layer**: User-scoped access with Row Level Security
4. **Database Layer**: PostgreSQL with secure policies and constraints
5. **Application Layer**: Input validation and rate limiting

### Security Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                     User Boundary                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   User A    │    │   User B    │    │   User C    │  │
│  │             │    │             │    │             │  │
│  │ ┌─────────┐ │    │ ┌─────────┐ │    │ ┌─────────┐ │  │
│  │ │Agents   │ │    │ │Agents   │ │    │ │Agents   │ │  │
│  │ │Channels │ │    │ │Channels │ │    │ │Channels │ │  │
│  │ │Data     │ │    │ │Data     │ │    │ │Data     │ │  │
│  │ └─────────┘ │    │ └─────────┘ │    │ └─────────┘ │  │
│  └─────────────┘    └─────────────┘    └─────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 📊 Performance Considerations

### Scalability Patterns

1. **Horizontal Agent Scaling**: Multiple agents per user
2. **Channel Isolation**: User-specific channels prevent cross-talk
3. **Database Indexing**: Optimized queries for agent lookup
4. **Connection Pooling**: Efficient Supabase client management

### Performance Optimizations

1. **Lazy Channel Creation**: Channels created on-demand
2. **Agent Caching**: In-memory agent registry
3. **Timeout Management**: Automatic cleanup of stale operations
4. **Batched Operations**: Efficient database updates

### Resource Management

```
Memory Usage:
├── Channel Manager: O(users) active channels
├── Tool Dispatcher: O(pending_calls) promise handlers
├── Agent Registry: O(agents) cached entries
└── MCP Server: O(sessions) transport objects

Database Load:
├── Agent Heartbeats: 1 UPDATE per agent per 30 seconds
├── Tool Calls: 1 INSERT + 1-2 UPDATEs per call
├── Channel Events: Real-time subscription overhead
└── Cleanup: Periodic DELETE operations
```

## 🚀 Extension Points

### Adding New Tools

1. **Server Tools**: Add to `src/server/tools/`
2. **Agent Tools**: Extend `DesktopIntegration` class
3. **Capability Reporting**: Update agent capabilities

### Custom Agent Types

1. **Specialized Agents**: Inherit from base `MCPAgent` class
2. **Tool Integrations**: Custom `DesktopIntegration` implementations
3. **Environment Adaptations**: Platform-specific optimizations

### Monitoring Integration

1. **Metrics Collection**: Tool call statistics and timing
2. **Health Checks**: Multi-level health monitoring
3. **Alerting**: Failed tool calls and agent disconnections
4. **Logging**: Structured logging with correlation IDs

## 🔍 Debugging and Observability

### Debug Interfaces

1. **Health Endpoint**: Real-time server status
2. **Agent Status Tool**: Connected agents overview
3. **Database Introspection**: Tool call history
4. **Log Aggregation**: Centralized logging

### Tracing Tool Calls

```
Request ID: req_123456
├── MCP Request Received (timestamp)
├── Agent Lookup (duration: 5ms)
├── Channel Broadcast (duration: 10ms)
├── Agent Processing (duration: 150ms)
├── Result Received (duration: 5ms)
└── MCP Response Sent (total: 170ms)
```

### Common Debug Scenarios

1. **Tool Call Timeouts**: Check agent connectivity and processing time
2. **Authentication Failures**: Verify OAuth flow and token validity
3. **Channel Issues**: Monitor Supabase real-time connection status
4. **Database Errors**: Check RLS policies and table permissions

## 🎯 Design Principles

### Reliability

- **Graceful Degradation**: System continues operating with reduced functionality
- **Timeout Management**: All operations have bounded execution time
- **Error Recovery**: Automatic retry and fallback mechanisms
- **State Persistence**: Critical state survives server restarts

### Security

- **Defense in Depth**: Multiple security layers
- **Principle of Least Privilege**: Minimal required permissions
- **User Isolation**: Complete separation of user data
- **Audit Trail**: Complete logging of security-relevant events

### Scalability

- **Stateless Design**: Servers can be horizontally scaled
- **Resource Pooling**: Efficient resource utilization
- **Asynchronous Operations**: Non-blocking I/O throughout
- **Caching Strategy**: Appropriate caching at each layer

### Maintainability

- **Modular Architecture**: Clear separation of concerns
- **Comprehensive Testing**: Unit and integration tests
- **Documentation**: Code and architecture documentation
- **Monitoring**: Observable system behavior

---

This architecture provides a robust foundation for distributed AI tool execution while maintaining security, performance, and scalability requirements.