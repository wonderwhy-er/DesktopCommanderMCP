# Architecture Guide

This document provides a comprehensive overview of the Desktop Commander Remote Server architecture, including system design, data flows, and implementation details.

## 🏗️ System Overview

The Desktop Commander Remote Server is a distributed system that enables remote tool execution through real-time communication channels. It bridges Claude Desktop with remote agents, providing a secure and scalable platform for distributed AI workflows.

### High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Claude Desktop │────►│ Desktop Commander │────►│  Remote Agent   │
│                 │     │ Remote Server   │     │  (Machine A)    │
│  - MCP Client   │◄────│                 │◄────│                 │
│  - Tool Calls   │     │ ┌─────────────┐ │     │ - Tool Executor │
│  - UI           │     │ │ Remote MCP  │ │     │ - Desktop Int.  │
│                 │     │ │ Manager     │ │     │ - OAuth Client  │
│                 │     │ └─────────────┘ │     └─────────────────┘
└─────────────────┘     │ ┌─────────────┐ │
┌─────────────────┐     │ │ Tool Call   │ │     ┌─────────────────┐
│                 │     │ │ Processor   │ │     │                 │
│  Web Browser    │────►│ └─────────────┘ │────►│  Remote Agent   │
│                 │     │                 │     │  (Machine B)    │
│ - OAuth Flow    │◄────│ ┌─────────────┐ │◄────│                 │
│ - Auth UI       │     │ │ OAuth       │ │     │ - Headless Mode │
│                 │     │ │ Provider    │ │     │ - Tool Executor │
└─────────────────┘     │ └─────────────┘ │     │ - SSH/Docker    │
                        └─────────────────┘     └─────────────────┘
                                 │
        ┌───────────────┐        │
        │               │◄───────┘
        │   Supabase    │
        │               │
        │ - PostgreSQL  │
        │ - Real-time   │
        │ - Auth        │
        │ - Row Security│
        └───────────────┘
```

## 🔧 Core Components

### 1. Desktop Commander Remote Server (`src/server/server.js`)

The central server that handles MCP protocol communication with Claude Desktop and orchestrates the remote tool execution.

**Responsibilities:**
- MCP protocol compliance via `@modelcontextprotocol/sdk`
- HTTP/HTTPS server with Express.js
- Authentication and session management
- Routing to sub-modules (OAuth, MCP, General)

### 2. Remote MCP Manager (`src/server/remote-mcp/remote-mcp.js`)

Handles the integration of the MCP SDK and manages tool registration and transport layers.

**Responsibilities:**
- Initializes `McpServer` and manages transports
- Registers static tools (e.g., `list_agents`) and dynamic remote tools
- Manages user-specific `ToolCallProcessor` instances
- Coordinates between incoming MCP requests and the tool execution logic

### 3. Tool Call Processor (`src/server/remote-mcp/tool-call-processor.js`)

Orchestrates the dispatching and tracking of tool execution calls to remote agents.

**Responsibilities:**
- Dispatches tool calls to specific agents via Supabase Realtime
- Manages the lifecycle of a tool call (pending -> executing -> completed/failed)
- Subscribes to global result channels to receive feedback from agents
- Handles timeouts and error states
- Queries `mcp_agents` to find available execution targets

**State Machine:**
```
pending → executing → completed/failed
   ↓         ↓            ↓
database  database   database
 insert   update     update
```

### 4. Remote Agent (`agent.js` & `src/agent/`)

Standalone agent that runs on the target machine, connects to the server, and executes requested tools.

**Responsibilities:**
- OAuth authentication (desktop/headless modes)
- Supabase client configuration
- Real-time channel subscription to receive job tokens
- Tool execution via `DesktopIntegration`
- Presence tracking and heartbeat

**Agent States:**
- **Initializing**: Starting up and configuring
- **Authenticating**: Completing OAuth flow
- **Online**: Ready to receive tool calls (Heartbeat active)
- **Executing**: Processing a tool call
- **Shutting Down**: Graceful disconnection

## 🔄 Data Flow Diagrams

### Tool Execution Flow

```
1. Tool Request
Claude Desktop ──MCP Request──► Remote Server (server.js)
                                      │
2. Route Request                      │
                                      ▼
                             Remote MCP Manager
                                      │
3. Dispatch                           │
                                      ▼
                            Tool Call Processor ──Query──► Database
                                      │                    │
4. Create Call Record                 │                    ▼
                                      ▼              mcp_remote_calls
                              Supabase Client            (INSERT)
                                      │
5. Broadcast                          │
                                      ▼
                             Supabase Channel
                                      │
6. Receive                            │
                                      ▼
                               Remote Agent
                                      │
7. Execute                            │
                                      ▼
                            Desktop Integration
                                      │
8. Result                             │
                                      ▼
                             Supabase Channel
                                      │
9. Handle Result                      │
                                      ▼
                            Tool Call Processor ──Update──► Database
                                      │                     │
10. Return Result                     │                     ▼
                                      ▼              mcp_remote_calls
                             Remote MCP Manager          (UPDATE)
                                      │
11. MCP Response                      │
                                      ▼
Claude Desktop ◄──MCP Response───── Remote Server
```

### Authentication Flow

```
1. Agent Start
Remote Agent ──HTTP Request──► Remote Server
                                      │
2. OAuth URL                          │
                                      ▼
Remote Agent ◄──OAuth URL──── OAuth Handler
      │                              │
3. Browser/Manual                    │
      ▼                              │
Web Browser ──Login/Signup──► Supabase Auth
                                      │
4. Callback                           │
                                      ▼
Remote Server ◄──Access Token───── OAuth Provider
                                      │
5. Token Response                     │
                                      ▼
Remote Agent ◄──Access Token──── Remote Server
      │
6. Client Config
      ▼
Supabase Client ──Get User──► Supabase Auth
      │                           │
7. Agent Registration             │
      ▼                           ▼
Agent Wrapper ──Insert──► Database (mcp_agents)
```

## 💾 Database Schema

### Entity Relationship Diagram

```
┌─────────────────┐     ┌─────────────────┐
│   mcp_agents    │     │mcp_remote_calls │
├─────────────────┤     ├─────────────────┤
│ id (PK, uuid)   │     │ id (PK)         │
│ user_id (FK)    │     │ user_id (FK)    │
│ agent_name      │     │ agent_id (FK)   │
│ capabilities    │     │ tool_name       │
│ status          │     │ tool_args       │
│ last_seen       │     │ status          │
│ auth_token      │     │ result          │
│ created_at      │     │ error_message   │
│ updated_at      │     │ created_at      │
│                 │     │ completed_at    │
└─────────────────┘     │ timeout_at      │
                        └─────────────────┘
```

### Table Purposes

1. **mcp_agents**: Registry of connected agents with capabilities and status. Unique constraint on `(user_id, agent_name)`.
2. **mcp_remote_calls**: Tool call queue and execution tracking.

### Row Level Security (RLS)

All tables implement user-scoped access:

```sql
-- Users can only access their own data
CREATE POLICY "User execution isolation" ON mcp_remote_calls 
FOR ALL USING (auth.uid() = user_id);
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
│  │ └─────────┘ │    └─────────────┘    └─────────────┘  │
└─────────────────┘                                         │
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
├── Tool Call Processor: O(pending_calls) promise handlers
├── Remote MCP Manager: O(sessions) transport objects
└── MCP Server: Single instance with registered tools

Database Load:
├── Agent Heartbeats: 1 UPDATE per agent per 30 seconds
├── Tool Calls: 1 INSERT + 1-2 UPDATEs per call
├── Channel Events: Real-time subscription overhead
└── Cleanup: Periodic DELETE operations (via RPC)
```

## 🚀 Extension Points

### Adding New Tools

1. **Server-Side Definition**: Add tool definition to `src/server/remote-mcp/clientTools/client-tools.js`.
2. **Agent Capabilities**: Ensure the agent's `DesktopIntegration` supports the new tool.
3. **Registration**: The `RemoteMcp` class automatically registers tools defined in `clientTools`.

### Custom Agent Types

1. **Specialized Agents**: Inherit from base `MCPAgent` class (if creating new agent implementation).
2. **Tool Integrations**: Custom `DesktopIntegration` implementations in `src/agent/desktop-integration.js`.

### Monitoring Integration

1. **Metrics Collection**: Tool call statistics and timing
2. **Health Checks**: Multi-level health monitoring
3. **Alerting**: Failed tool calls and agent disconnections
4. **Logging**: Structured logging with correlation IDs

## 🔍 Debugging and Observability

### Debug Interfaces

1. **Server Logs**: Structured logging via `serverLogger` and `mcpLogger`.
2. **Agent Status Tool**: `agent_status` tool to view connected agents.
3. **Database Introspection**: Direct query of `mcp_remote_calls` table.

### Tracing Tool Calls

```
Request ID: req_xxx
├── MCP Request Received
├── Route to Remote MCP
├── Tool Call Processor Dispatch
├── Remote Call Record Created
├── Agent Execution
├── Result Received via Realtime
└── MCP Response Sent
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