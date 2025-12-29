# Remote MCP Server - Workflow Diagrams

This document contains detailed workflow diagrams for understanding all processes in the Remote MCP Server system.

---

## 🔄 Complete OAuth 2.1 Authentication Flow

```mermaid
sequenceDiagram
    participant Client as Claude Desktop
    participant Auth as OAuth Server<br/>(Port 4448)
    participant MCP as MCP Server<br/>(Port 3005)
    participant Agent as Local Agent<br/>(Target Machine)

    Note over Client, Agent: OAuth 2.1 Authorization Code Flow with PKCE

    %% Client Registration
    Client->>Auth: 1. POST /register<br/>Dynamic Client Registration
    Auth-->>Client: 2. client_id, client_secret

    %% PKCE Generation
    Note over Client: 3. Generate PKCE<br/>code_verifier, code_challenge

    %% Authorization Request
    Client->>Auth: 4. GET /authorize?<br/>response_type=code&<br/>client_id=...&<br/>code_challenge=...&<br/>state=...
    
    Note over Auth: 5. User Authentication<br/>(Demo: Auto-approve)
    
    Auth-->>Client: 6. HTTP 302 Redirect<br/>callback?code=...&state=...

    %% Token Exchange
    Client->>Auth: 7. POST /token<br/>grant_type=authorization_code&<br/>code=...&<br/>code_verifier=...
    Auth-->>Client: 8. access_token, token_type=bearer

    %% MCP Connection
    Client->>MCP: 9. GET /sse<br/>Authorization: Bearer <token>
    
    MCP->>Auth: 10. POST /introspect<br/>token=<access_token>
    Auth-->>MCP: 11. Token validation result
    
    MCP-->>Client: 12. SSE Connection Established<br/>event-stream

    %% MCP Communication
    Client->>MCP: 13. MCP Tool Call<br/>(via SSE)
    MCP->>Agent: 14. Forward Command<br/>(Device Token Auth)
    Agent-->>MCP: 15. Command Result
    MCP-->>Client: 16. Tool Response<br/>(via SSE)
```

---

## 🏗 System Architecture Flow

```mermaid
graph TB
    subgraph "Claude Desktop Environment"
        Claude[Claude Desktop]
        Config[claude_desktop_config.json]
    end

    subgraph "OAuth Infrastructure (Port 4448)"
        AuthServer[OAuth Authorization Server]
        ClientReg[Client Registration]
        TokenEndpoint[Token Endpoint]
        Introspect[Introspection Endpoint]
        Metadata[Metadata Endpoint]
    end

    subgraph "MCP Resource Server (Port 3005)"
        MCPServer[MCP Server<br/>Spec Compliant]
        SSEEndpoint[SSE Endpoint]
        AuthMiddleware[Auth Middleware]
        HealthEndpoint[Health Endpoint]
    end

    subgraph "Remote Infrastructure (Port 3002/3003)"
        RemoteServer[Remote MCP Server<br/>Traditional]
        Database[(PostgreSQL<br/>Database)]
        WebDash[Web Dashboard]
    end

    subgraph "Target Machine"
        Agent[Local MCP Agent]
        DesktopCmd[Desktop Commander<br/>MCP Tools]
        FileSystem[File System]
        Processes[System Processes]
    end

    subgraph "Monitoring & Logging"
        Monitor[Monitor Script]
        Logs[JSON Logs]
        HealthCheck[Health Checks]
    end

    %% OAuth Flow
    Claude -->|1. OAuth Registration| AuthServer
    Claude -->|2. Authorization Request| AuthServer
    Claude -->|3. Token Exchange| TokenEndpoint
    
    %% MCP Communication
    Claude -->|4. SSE + Bearer Token| MCPServer
    MCPServer -->|5. Token Validation| Introspect
    MCPServer -->|6. Authenticated Stream| SSEEndpoint
    
    %% Remote Execution
    MCPServer -->|7. Device Token Auth| RemoteServer
    RemoteServer -->|8. SSE Connection| Agent
    Agent -->|9. Execute Commands| DesktopCmd
    DesktopCmd -->|10. File Operations| FileSystem
    DesktopCmd -->|11. Process Control| Processes

    %% Database & Monitoring
    RemoteServer <--> Database
    RemoteServer --> WebDash
    MCPServer --> Monitor
    Monitor --> Logs
    Monitor --> HealthCheck

    %% Configuration
    Config -.->|MCP Server URLs| Claude
```

---

## 🔐 Detailed OAuth Security Flow

```mermaid
sequenceDiagram
    participant App as Client Application
    participant Auth as Authorization Server
    participant Resource as Resource Server
    participant User as End User

    Note over App, User: OAuth 2.1 Security Features

    %% PKCE Generation
    Note over App: Generate PKCE Parameters<br/>code_verifier = random(43-128 chars)<br/>code_challenge = SHA256(code_verifier)

    %% State Parameter
    Note over App: Generate State Parameter<br/>state = random(minimum 8 chars)<br/>For CSRF Protection

    %% Authorization Request
    App->>Auth: Authorization Request<br/>GET /authorize?<br/>response_type=code&<br/>client_id=CLIENT_ID&<br/>redirect_uri=REDIRECT_URI&<br/>scope=mcp:tools&<br/>state=STATE&<br/>code_challenge=CHALLENGE&<br/>code_challenge_method=S256

    Auth->>User: Authentication Challenge<br/>(Login Form or SSO)
    User-->>Auth: Credentials / Consent

    Note over Auth: Validate:<br/>- Client ID exists<br/>- Redirect URI matches<br/>- Scope is valid<br/>- Code challenge is present

    Auth-->>App: Authorization Response<br/>HTTP 302 Redirect<br/>REDIRECT_URI?code=AUTH_CODE&state=STATE

    Note over App: Validate State Parameter<br/>(CSRF Protection)

    %% Token Exchange with PKCE
    App->>Auth: Token Request<br/>POST /token<br/>Content-Type: application/x-www-form-urlencoded<br/><br/>grant_type=authorization_code&<br/>code=AUTH_CODE&<br/>redirect_uri=REDIRECT_URI&<br/>client_id=CLIENT_ID&<br/>client_secret=CLIENT_SECRET&<br/>code_verifier=CODE_VERIFIER

    Note over Auth: Validate:<br/>- Authorization code exists<br/>- Client credentials valid<br/>- Redirect URI matches<br/>- PKCE: SHA256(code_verifier) = code_challenge

    Auth-->>App: Token Response<br/>{<br/>  "access_token": "TOKEN",<br/>  "token_type": "bearer",<br/>  "expires_in": 3600,<br/>  "scope": "mcp:tools"<br/>}

    %% Resource Access
    App->>Resource: Protected Resource Request<br/>Authorization: Bearer TOKEN

    Resource->>Auth: Token Introspection<br/>POST /introspect<br/>token=TOKEN

    Auth-->>Resource: Introspection Response<br/>{<br/>  "active": true,<br/>  "client_id": "CLIENT_ID",<br/>  "scope": "mcp:tools",<br/>  "exp": 1766658281<br/>}

    Resource-->>App: Protected Resource<br/>(MCP Server Response)
```

---

## 🌐 Multi-Component System Flow

```mermaid
graph LR
    subgraph "Development Environment"
        DevClaude[Claude Desktop<br/>Development]
        DevConfig[Dev Config<br/>localhost:3005]
    end

    subgraph "OAuth Demo Server (Port 4448)"
        DemoAuth[Demo OAuth Provider<br/>In-Memory Storage]
        DemoReg[Client Registration]
        DemoToken[Token Management]
    end

    subgraph "MCP Spec Server (Port 3005)"
        SpecMCP[Specification Compliant<br/>MCP Server]
        SSE[SSE Transport]
        Bearer[Bearer Auth]
    end

    subgraph "Production Environment"
        ProdClaude[Claude Desktop<br/>Production]
        ProdConfig[Prod Config<br/>HTTPS URLs]
    end

    subgraph "Ory Infrastructure"
        Hydra[Ory Hydra<br/>OAuth Server]
        Kratos[Ory Kratos<br/>Identity Management]
        PostgresOry[(PostgreSQL<br/>Ory Database)]
    end

    subgraph "Traditional MCP (Port 3002/3003)"
        TraditionalMCP[Traditional MCP Server<br/>SSE + JWT]
        PostgresMCP[(PostgreSQL<br/>MCP Database)]
        JWTAuth[JWT Device Tokens]
    end

    subgraph "Remote Machines"
        Agent1[Agent Machine 1]
        Agent2[Agent Machine 2]
        Agent3[Agent Machine N...]
    end

    %% Development Flow
    DevClaude -->|OAuth 2.1| DemoAuth
    DevClaude -->|MCP + Bearer| SpecMCP
    DemoAuth -.-> DemoReg
    DemoAuth -.-> DemoToken

    %% Production Flow
    ProdClaude -->|OAuth 2.1| Hydra
    ProdClaude -->|MCP + Bearer| SpecMCP
    Hydra <--> Kratos
    Hydra <--> PostgresOry
    Kratos <--> PostgresOry

    %% Traditional Flow
    DevClaude -->|Alternative| TraditionalMCP
    TraditionalMCP <--> PostgresMCP
    TraditionalMCP -.-> JWTAuth

    %% Remote Execution
    SpecMCP -->|Device Tokens| Agent1
    SpecMCP -->|Device Tokens| Agent2
    SpecMCP -->|Device Tokens| Agent3
    TraditionalMCP -->|SSE + JWT| Agent1
    TraditionalMCP -->|SSE + JWT| Agent2
    TraditionalMCP -->|SSE + JWT| Agent3

    %% Styling
    classDef oauth fill:#e1f5fe
    classDef mcp fill:#f3e5f5
    classDef agent fill:#e8f5e8
    classDef db fill:#fff3e0

    class DemoAuth,Hydra,Kratos oauth
    class SpecMCP,TraditionalMCP mcp
    class Agent1,Agent2,Agent3 agent
    class PostgresOry,PostgresMCP db
```

---

## 📊 Component Interaction Matrix

```mermaid
graph TD
    subgraph "Authentication Layer"
        A1[OAuth Registration]
        A2[Token Generation]
        A3[Token Validation]
        A4[Session Management]
    end

    subgraph "Transport Layer"
        T1[HTTP/HTTPS]
        T2[Server-Sent Events]
        T3[WebSocket fallback]
        T4[stdio transport]
    end

    subgraph "Protocol Layer"
        P1[MCP JSON-RPC]
        P2[OAuth 2.1 Flow]
        P3[Bearer Tokens]
        P4[JWT Device Tokens]
    end

    subgraph "Application Layer"
        L1[Desktop Commander Tools]
        L2[File System Operations]
        L3[Process Management]
        L4[System Information]
    end

    subgraph "Storage Layer"
        S1[PostgreSQL Database]
        S2[In-Memory Cache]
        S3[File System]
        S4[Log Files]
    end

    %% Connections
    A1 --> P2
    A2 --> P3
    A3 --> P3
    A4 --> S2

    T1 --> P2
    T2 --> P1
    T3 --> P1
    T4 --> P1

    P1 --> L1
    P2 --> A1
    P3 --> A3
    P4 --> A3

    L1 --> L2
    L1 --> L3
    L1 --> L4
    L2 --> S3
    L3 --> S3

    S1 --> A4
    S2 --> A3
    S4 --> L4
```

---

## 🔧 Error Handling and Recovery Flow

```mermaid
stateDiagram-v2
    [*] --> ServerStartup
    
    ServerStartup --> PortCheck
    PortCheck --> PortAvailable : Success
    PortCheck --> PortConflict : Port in use
    
    PortConflict --> KillExisting : Auto-kill
    PortConflict --> UseAlternate : Manual config
    KillExisting --> PortAvailable
    UseAlternate --> PortAvailable
    
    PortAvailable --> OAuth_Setup
    OAuth_Setup --> OAuth_Ready : Success
    OAuth_Setup --> OAuth_Error : Failure
    
    OAuth_Error --> Retry_OAuth : Transient error
    OAuth_Error --> [*] : Fatal error
    Retry_OAuth --> OAuth_Setup
    
    OAuth_Ready --> MCP_Server_Start
    MCP_Server_Start --> Running : Success
    MCP_Server_Start --> MCP_Error : Failure
    
    MCP_Error --> Restart_MCP : Recoverable
    MCP_Error --> [*] : Fatal
    Restart_MCP --> MCP_Server_Start
    
    Running --> Health_Check
    Health_Check --> Running : Healthy
    Health_Check --> Degraded : Issues detected
    Health_Check --> Failed : Critical failure
    
    Degraded --> Recovery_Attempt
    Recovery_Attempt --> Running : Success
    Recovery_Attempt --> Failed : Cannot recover
    
    Failed --> Auto_Restart : Enabled
    Failed --> [*] : Manual intervention required
    Auto_Restart --> ServerStartup
    
    Running --> Graceful_Shutdown : SIGTERM/SIGINT
    Graceful_Shutdown --> [*]
    
    Running --> Force_Kill : SIGKILL (exit 137)
    Force_Kill --> Auto_Restart : Monitor active
    Force_Kill --> [*] : No monitor
```

---

## 🚀 Deployment Strategy Diagram

```mermaid
graph TB
    subgraph "Development Environment"
        DevLocal[Local Development<br/>npm run dev]
        DevTest[Unit Testing<br/>jest/mocha]
        DevDebug[Debug Logging<br/>monitor-mcp-server.js]
    end

    subgraph "Staging Environment"
        StagingDocker[Docker Compose<br/>docker-compose.oauth.yml]
        StagingOry[Ory Stack<br/>Hydra + Kratos]
        StagingDB[(Staging Database<br/>PostgreSQL)]
    end

    subgraph "Production Environment"
        ProdK8s[Kubernetes<br/>Deployment]
        ProdLB[Load Balancer<br/>NGINX/HAProxy]
        ProdDB[(Production Database<br/>PostgreSQL Cluster)]
    end

    subgraph "Monitoring & Observability"
        Metrics[Prometheus<br/>Metrics]
        Logs[Centralized Logging<br/>ELK Stack]
        Alerts[Alerting<br/>PagerDuty]
        Dashboards[Grafana<br/>Dashboards]
    end

    subgraph "Security & Compliance"
        TLS[TLS Certificates<br/>Let's Encrypt]
        Secrets[Secret Management<br/>Vault/K8s Secrets]
        Audit[Audit Logging<br/>Compliance]
    end

    %% Development Flow
    DevLocal --> DevTest
    DevTest --> DevDebug
    DevDebug --> StagingDocker

    %% Staging Flow
    StagingDocker --> StagingOry
    StagingOry --> StagingDB
    StagingDocker --> ProdK8s

    %% Production Flow
    ProdK8s --> ProdLB
    ProdLB --> ProdDB
    ProdK8s --> Metrics
    ProdK8s --> Logs

    %% Monitoring
    Metrics --> Dashboards
    Logs --> Alerts
    Alerts --> Dashboards

    %% Security
    ProdLB --> TLS
    ProdK8s --> Secrets
    Logs --> Audit

    %% Styling
    classDef dev fill:#e3f2fd
    classDef staging fill:#f3e5f5
    classDef prod fill:#e8f5e8
    classDef monitor fill:#fff3e0
    classDef security fill:#ffebee

    class DevLocal,DevTest,DevDebug dev
    class StagingDocker,StagingOry,StagingDB staging
    class ProdK8s,ProdLB,ProdDB prod
    class Metrics,Logs,Alerts,Dashboards monitor
    class TLS,Secrets,Audit security
```

---

## 📈 Performance and Scaling

```mermaid
graph LR
    subgraph "Load Balancing"
        LB[Load Balancer]
        Instance1[MCP Server 1<br/>Port 3005]
        Instance2[MCP Server 2<br/>Port 3006]
        Instance3[MCP Server N<br/>Port 300X]
    end

    subgraph "OAuth Scaling"
        OAuthLB[OAuth Load Balancer]
        OAuth1[OAuth Server 1<br/>Port 4448]
        OAuth2[OAuth Server 2<br/>Port 4449]
        SharedCache[(Redis Cache<br/>Token Storage)]
    end

    subgraph "Database Scaling"
        DBProxy[Database Proxy<br/>pgBouncer]
        Primary[(Primary DB<br/>Write)]
        Replica1[(Replica 1<br/>Read)]
        Replica2[(Replica 2<br/>Read)]
    end

    subgraph "Agent Scaling"
        AgentPool[Agent Pool<br/>Multiple Machines]
        Agent1[Agent Instance 1]
        Agent2[Agent Instance 2]
        AgentN[Agent Instance N]
    end

    %% Load Balancing
    LB --> Instance1
    LB --> Instance2
    LB --> Instance3

    %% OAuth Scaling
    OAuthLB --> OAuth1
    OAuthLB --> OAuth2
    OAuth1 <--> SharedCache
    OAuth2 <--> SharedCache

    %% Database Scaling
    Instance1 --> DBProxy
    Instance2 --> DBProxy
    Instance3 --> DBProxy
    DBProxy --> Primary
    DBProxy --> Replica1
    DBProxy --> Replica2

    %% Agent Distribution
    Instance1 --> AgentPool
    Instance2 --> AgentPool
    Instance3 --> AgentPool
    AgentPool --> Agent1
    AgentPool --> Agent2
    AgentPool --> AgentN

    %% Cross-connections
    Instance1 -.-> OAuthLB
    Instance2 -.-> OAuthLB
    Instance3 -.-> OAuthLB
```

This comprehensive collection of workflow diagrams provides visual understanding of all processes in the Remote MCP Server system, from basic OAuth flows to complex deployment strategies and scaling patterns.