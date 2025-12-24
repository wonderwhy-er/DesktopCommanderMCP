# Technical Architecture

## Overview

This document provides detailed technical specifications for the Remote MCP extension architecture, including data flows, communication protocols, and implementation details for all three components.

## System Architecture

### High-Level Component Diagram

```mermaid
graph TB
    subgraph "Client Environment"
        A[Claude Desktop]
        A1[MCP Client Library]
    end
    
    subgraph "Cloud Infrastructure"
        B[Load Balancer]
        C[Remote MCP API Gateway]
        D[Authentication Service]
        E[Device Registry]
        F[Message Router]
        G[Session Manager]
        H[Database Cluster]
        I[Message Queue]
        J[Monitoring & Logging]
    end
    
    subgraph "Remote Machines"
        K[Desktop Commander Agent 1]
        L[Desktop Commander Agent 2]
        M[Desktop Commander Agent N]
        K1[Local MCP Server 1]
        L1[Local MCP Server 2] 
        M1[Local MCP Server N]
    end
    
    A --> A1
    A1 -.->|HTTPS/WSS| B
    B --> C
    C --> D
    C --> E
    C --> F
    F --> G
    F --> I
    C --> J
    D --> H
    E --> H
    G --> H
    
    I -.->|WebSocket/gRPC| K
    I -.->|WebSocket/gRPC| L
    I -.->|WebSocket/gRPC| M
    
    K --> K1
    L --> L1
    M --> M1
```

## Data Flow Architecture

### Request Processing Flow

```mermaid
sequenceDiagram
    participant C as Claude Desktop
    participant API as MCP API Gateway
    participant AUTH as Auth Service
    participant ROUTER as Message Router
    participant QUEUE as Message Queue
    participant AGENT as Desktop Commander Agent
    participant LOCAL as Local MCP Server

    C->>API: MCP Request (with auth token)
    API->>AUTH: Validate token
    AUTH->>API: Token validation + user context
    API->>ROUTER: Route request to user devices
    ROUTER->>QUEUE: Queue request for target device(s)
    QUEUE->>AGENT: Forward MCP request via WebSocket
    AGENT->>LOCAL: Execute MCP tool locally
    LOCAL->>AGENT: Return tool results
    AGENT->>QUEUE: Send results back
    QUEUE->>ROUTER: Route response
    ROUTER->>API: Aggregate responses
    API->>C: Return MCP response
```

### Multi-Device Request Handling

```mermaid
graph LR
    A[MCP Request] --> B{Device Target}
    B -->|Single Device| C[Direct Route]
    B -->|Multiple Devices| D[Parallel Execution]
    B -->|Device Group| E[Group Broadcast]
    
    C --> F[Execute on Device 1]
    D --> G[Execute on Device 1]
    D --> H[Execute on Device 2]
    D --> I[Execute on Device N]
    E --> J[Execute on Group Devices]
    
    F --> K[Single Response]
    G --> L[Aggregate Responses]
    H --> L
    I --> L
    J --> M[Group Response]
```

## Communication Protocols

### MCP Over HTTPS

**Client to Cloud Service**:
- Protocol: HTTPS/2 with WebSocket upgrade
- Authentication: Bearer token in Authorization header
- Content-Type: `application/json`
- Custom headers for MCP protocol versioning

```typescript
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
  meta?: {
    targetDevices?: string[];
    timeout?: number;
    parallel?: boolean;
  };
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: MCPError;
  meta?: {
    sourceDevice?: string;
    executionTime?: number;
    aggregated?: boolean;
  };
}
```

### Agent Communication Protocol

**Cloud to Agent Communication**:
- Protocol: WebSocket Secure (WSS) with gRPC fallback
- Authentication: JWT token on connection + message signing
- Compression: gzip for large payloads
- Heartbeat: 30-second intervals with exponential backoff

```typescript
interface AgentMessage {
  type: 'mcp_request' | 'heartbeat' | 'config_update' | 'disconnect';
  id: string;
  timestamp: number;
  payload: any;
  signature?: string; // HMAC-SHA256 for critical operations
}

interface AgentResponse {
  type: 'mcp_response' | 'heartbeat_ack' | 'error' | 'status';
  id: string;
  timestamp: number;
  payload: any;
  executionMeta?: {
    startTime: number;
    endTime: number;
    memoryUsed: number;
    cpuTime: number;
  };
}
```

## Component Specifications

### 1. Remote MCP API Gateway

**Technology Stack**:
- Runtime: Node.js 20+ with TypeScript
- Framework: Fastify with MCP plugin architecture
- WebSocket: ws library with custom protocol handling
- Database: PostgreSQL with Redis for caching
- Message Queue: Redis with Bull queue management

**Core Services**:

```typescript
class MCPGateway {
  private authService: AuthenticationService;
  private deviceRegistry: DeviceRegistry;
  private messageRouter: MessageRouter;
  private sessionManager: SessionManager;

  async handleMCPRequest(request: MCPRequest, userToken: string): Promise<MCPResponse> {
    // 1. Validate authentication
    const user = await this.authService.validateToken(userToken);
    
    // 2. Resolve target devices
    const devices = await this.deviceRegistry.getDevicesForUser(user.id);
    const targetDevices = this.resolveTargetDevices(request.meta?.targetDevices, devices);
    
    // 3. Route request
    const results = await this.messageRouter.routeToDevices(request, targetDevices);
    
    // 4. Aggregate and return
    return this.aggregateResponses(results);
  }
}
```

**Key Features**:
- Horizontal scaling with Redis session storage
- Request deduplication and caching
- Circuit breaker pattern for agent connections
- Rate limiting and quota management
- Real-time monitoring and alerting

### 2. Desktop Commander Remote Agent

**Enhanced Local Architecture**:

```typescript
class RemoteDesktopCommanderAgent {
  private websocketClient: WebSocketClient;
  private mcpServer: DesktopCommanderMCP;
  private authManager: DeviceAuthManager;
  private connectionManager: ConnectionManager;

  async initialize(): Promise<void> {
    // Load device credentials
    await this.authManager.loadCredentials();
    
    // Initialize local MCP server
    await this.mcpServer.initialize();
    
    // Establish cloud connection
    await this.connectionManager.connect();
    
    // Start message handling
    this.websocketClient.onMessage(this.handleRemoteRequest.bind(this));
  }

  private async handleRemoteRequest(message: AgentMessage): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Execute MCP request locally
      const result = await this.mcpServer.handleRequest(message.payload);
      
      // Send response back to cloud
      await this.websocketClient.send({
        type: 'mcp_response',
        id: message.id,
        timestamp: Date.now(),
        payload: result,
        executionMeta: {
          startTime,
          endTime: Date.now(),
          memoryUsed: process.memoryUsage().heapUsed,
          cpuTime: process.cpuUsage().system
        }
      });
    } catch (error) {
      // Handle errors and send error response
      await this.websocketClient.send({
        type: 'error',
        id: message.id,
        timestamp: Date.now(),
        payload: { error: error.message }
      });
    }
  }
}
```

**Connection Management**:
- Persistent WebSocket with automatic reconnection
- Exponential backoff for connection failures
- Graceful degradation during network issues
- Local operation queuing during disconnection

### 3. Device Registry Service

**Device Management**:

```typescript
interface Device {
  id: string;
  userId: string;
  name: string;
  type: 'desktop' | 'server' | 'mobile';
  capabilities: string[];
  lastSeen: Date;
  status: 'online' | 'offline' | 'maintenance';
  configuration: {
    allowedDirectories: string[];
    blockedCommands: string[];
    resourceLimits: {
      maxMemory: number;
      maxCPU: number;
      maxDisk: number;
    };
  };
  metadata: {
    os: string;
    architecture: string;
    version: string;
    ipAddress?: string;
    location?: string;
  };
}

class DeviceRegistry {
  async registerDevice(userId: string, deviceInfo: Partial<Device>): Promise<Device> {
    // Generate device ID and credentials
    const device = await this.createDevice(userId, deviceInfo);
    
    // Store in database
    await this.db.devices.create(device);
    
    // Generate device token
    const token = await this.authService.generateDeviceToken(device);
    
    return { ...device, token };
  }

  async getActiveDevicesForUser(userId: string): Promise<Device[]> {
    return this.db.devices.findMany({
      where: {
        userId,
        status: 'online',
        lastSeen: {
          gte: new Date(Date.now() - 5 * 60 * 1000) // 5 minutes
        }
      }
    });
  }
}
```

## Performance Considerations

### Scalability Targets

**Concurrent Users**: 10,000+ simultaneous users
**Device Connections**: 100,000+ connected devices
**Request Throughput**: 50,000+ requests per second
**Response Latency**: < 2 seconds end-to-end for typical operations

### Optimization Strategies

**Caching**:
- Redis for session data and device status
- CDN for static assets and configuration
- Application-level caching for user device mappings

**Database Optimization**:
- Read replicas for device queries
- Partitioning by user ID for large tables
- Connection pooling and prepared statements

**Message Queue Optimization**:
- Topic-based routing for efficient device targeting
- Batch processing for bulk operations
- Dead letter queues for failed requests

### Monitoring and Observability

**Metrics Collection**:
- Request latency and throughput
- Device connection status and health
- Authentication success/failure rates
- Resource utilization per component

**Logging Strategy**:
- Structured JSON logging
- Request tracing across components
- Security event logging
- Performance profiling data

**Alerting**:
- SLA breach notifications
- Security anomaly detection
- Infrastructure health monitoring
- Capacity planning alerts

This architecture provides a robust, scalable foundation for remote MCP operations while maintaining security and performance requirements.