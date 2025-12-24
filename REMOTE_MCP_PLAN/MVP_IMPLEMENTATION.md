# MVP Implementation Guide

## 4-Week Sprint Plan

### Week 1: Authentication Foundation

**Goal**: Working OAuth login with Ory stack

**Tasks**:
```bash
# 1. Setup project structure
mkdir remote-mcp-mvp
cd remote-mcp-mvp
npm init -y
npm install express cors helmet morgan
npm install @ory/kratos-client @ory/hydra-client
npm install pg uuid jsonwebtoken ws
npm install -D @types/node typescript ts-node nodemon

# 2. Setup Ory services
docker-compose up -d postgres kratos hydra

# 3. Configure OAuth providers (Google)
# 4. Basic Express server with OAuth routes
```

**Deliverables**:
- [x] Docker compose with Ory + Postgres
- [x] OAuth login flow working
- [x] User creation in database
- [x] JWT token generation

### Week 2: Device Management

**Goal**: Device registration and WebSocket connection

**Tasks**:
```typescript
// Device registration endpoint
app.post('/api/device/register', async (req, res) => {
  const { name } = req.body;
  const userId = req.user.id;
  
  // Check if user already has a device (MVP: only one device)
  const existing = await db.devices.findByUserId(userId);
  if (existing) {
    return res.status(400).json({ error: 'Device already registered' });
  }
  
  const device = await db.devices.create({
    userId,
    name,
    status: 'offline'
  });
  
  const deviceToken = jwt.sign({ deviceId: device.id, userId }, JWT_SECRET);
  
  res.json({
    deviceId: device.id,
    deviceToken,
    websocketUrl: `wss://${req.host}/ws/device`
  });
});
```

**Deliverables**:
- [x] Device registration API
- [x] WebSocket server setup
- [x] Device token generation
- [x] Basic device status tracking

### Week 3: MCP Integration

**Goal**: End-to-end MCP request execution

**Remote MCP Server**:
```typescript
// MCP execution endpoint
app.post('/api/mcp/execute', async (req, res) => {
  const userId = req.user.id;
  const mcpRequest = req.body;
  
  // Get user's device
  const device = await db.devices.findByUserId(userId);
  if (!device || device.status !== 'online') {
    return res.status(400).json({ error: 'Device not available' });
  }
  
  // Forward request via WebSocket
  const result = await websocketManager.sendToDevice(device.id, mcpRequest);
  res.json(result);
});

// WebSocket handler
websocketServer.on('connection', (ws, req) => {
  const deviceToken = req.headers.authorization?.replace('Bearer ', '');
  const { deviceId } = jwt.verify(deviceToken, JWT_SECRET);
  
  // Register device connection
  deviceConnections.set(deviceId, ws);
  
  ws.on('message', (data) => {
    const response = JSON.parse(data);
    // Handle MCP response from device
    pendingRequests.get(response.id)?.resolve(response);
  });
  
  ws.on('close', () => {
    deviceConnections.delete(deviceId);
  });
});
```

**Desktop Commander Remote Client**:
```typescript
// Enhanced Desktop Commander with remote connectivity
class RemoteDesktopCommander {
  private ws: WebSocket;
  private localMCP: DesktopCommanderMCP;
  
  async connect(websocketUrl: string, deviceToken: string) {
    this.ws = new WebSocket(websocketUrl, {
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    
    this.ws.on('message', async (data) => {
      const request = JSON.parse(data);
      
      // Execute MCP request locally
      const result = await this.localMCP.handleRequest(request);
      
      // Send result back to server
      this.ws.send(JSON.stringify({
        id: request.id,
        ...result
      }));
    });
  }
}
```

**Deliverables**:
- [x] MCP request forwarding
- [x] WebSocket communication
- [x] Enhanced Desktop Commander agent
- [x] Basic error handling

### Week 4: Polish & Deploy

**Goal**: Working MVP with simple dashboard

**Simple Web Dashboard**:
```html
<!-- public/dashboard.html -->
<!DOCTYPE html>
<html>
<head>
    <title>Remote MCP Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; }
        .device { border: 1px solid #ddd; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .online { border-color: green; }
        .offline { border-color: red; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; }
        .test-area { margin-top: 30px; padding: 20px; background: #f5f5f5; }
        textarea { width: 100%; height: 100px; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>Remote MCP Dashboard</h1>
    
    <div id="user-info">
        <h2>Welcome, <span id="username"></span></h2>
        <button onclick="logout()">Logout</button>
    </div>
    
    <div id="device-section">
        <h2>Your Device</h2>
        <div id="device-info">
            <!-- Device info will be loaded here -->
        </div>
        <div id="no-device" style="display: none;">
            <p>No device registered.</p>
            <button onclick="registerDevice()">Register Device</button>
        </div>
    </div>
    
    <div class="test-area">
        <h3>Test MCP Command</h3>
        <textarea id="mcp-request" placeholder='{"jsonrpc":"2.0","id":"1","method":"read_file","params":{"path":"/etc/hostname"}}'></textarea>
        <br>
        <button onclick="testMCP()">Execute</button>
        <pre id="mcp-result"></pre>
    </div>

    <script>
        // Load user and device info
        async function loadDashboard() {
            const token = localStorage.getItem('authToken');
            if (!token) {
                window.location.href = '/auth/login';
                return;
            }
            
            // Load user info
            const userRes = await fetch('/api/user', {
                headers: { Authorization: `Bearer ${token}` }
            });
            const user = await userRes.json();
            document.getElementById('username').textContent = user.name;
            
            // Load device info
            const deviceRes = await fetch('/api/device', {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            if (deviceRes.ok) {
                const device = await deviceRes.json();
                showDevice(device);
            } else {
                document.getElementById('no-device').style.display = 'block';
            }
        }
        
        function showDevice(device) {
            const deviceInfo = document.getElementById('device-info');
            deviceInfo.innerHTML = `
                <div class="device ${device.status}">
                    <h3>${device.name}</h3>
                    <p>Status: <strong>${device.status}</strong></p>
                    <p>Last seen: ${new Date(device.lastSeen).toLocaleString()}</p>
                </div>
            `;
        }
        
        async function testMCP() {
            const token = localStorage.getItem('authToken');
            const request = JSON.parse(document.getElementById('mcp-request').value);
            
            const response = await fetch('/api/mcp/execute', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify(request)
            });
            
            const result = await response.json();
            document.getElementById('mcp-result').textContent = JSON.stringify(result, null, 2);
        }
        
        loadDashboard();
    </script>
</body>
</html>
```

**Deployment**:
```bash
# Simple VPS deployment
scp -r . user@your-server:/app/remote-mcp
ssh user@your-server "cd /app/remote-mcp && docker-compose up -d"
```

**Deliverables**:
- [x] Simple web dashboard
- [x] Device management UI
- [x] MCP testing interface
- [x] Basic deployment setup

## Minimal Code Examples

### Server Structure
```
src/
├── server.ts              # Main Express server
├── auth/
│   ├── oauth.ts           # Ory Kratos integration
│   └── middleware.ts      # JWT validation
├── device/
│   ├── routes.ts          # Device API endpoints
│   └── websocket.ts       # WebSocket handling
├── mcp/
│   └── handler.ts         # MCP request forwarding
└── database/
    ├── connection.ts      # PostgreSQL connection
    └── models.ts          # Simple models
```

### Essential Environment Variables
```bash
# .env
DATABASE_URL=postgres://user:password@localhost:5432/remotemcp
JWT_SECRET=your-secret-key
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
HYDRA_PUBLIC_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

### Docker Compose
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: remotemcp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  kratos:
    image: oryd/kratos:v1.0.0
    environment:
      - DSN=postgres://postgres:password@postgres:5432/remotemcp?sslmode=disable
    ports:
      - "4433:4433"
      - "4434:4434"
    volumes:
      - ./kratos:/etc/config/kratos

  hydra:
    image: oryd/hydra:v2.2.0
    environment:
      - DSN=postgres://postgres:password@postgres:5432/remotemcp?sslmode=disable
    ports:
      - "4444:4444"
      - "4445:4445"
    volumes:
      - ./hydra:/etc/config/hydra

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgres://postgres:password@postgres:5432/remotemcp
      - JWT_SECRET=your-secret-key
    depends_on:
      - postgres
      - kratos
      - hydra

volumes:
  postgres_data:
```

This MVP implementation gets you from zero to working Remote MCP in 4 weeks with minimal complexity and maximum functionality.