# Remote MCP MVP - Quick Start Guide

## 🚀 Get Started in 30 Minutes

This guide gets you running a basic Remote MCP setup locally for development.

## Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Git

## Quick Setup

### 1. Clone and Setup
```bash
# Create project structure
mkdir remote-mcp-mvp && cd remote-mcp-mvp

# Initialize Node.js project
npm init -y
npm install express cors helmet morgan ws jsonwebtoken pg uuid
npm install @ory/kratos-client @ory/hydra-client
npm install -D typescript @types/node @types/express @types/ws ts-node nodemon

# Create TypeScript config
cat > tsconfig.json << EOF
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
EOF
```

### 2. Docker Setup
```bash
# Create docker-compose.yml
cat > docker-compose.yml << 'EOF'
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: remotemcp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
EOF

# Start database
docker-compose up -d postgres
```

### 3. Basic Server
```bash
mkdir -p src/{auth,device,mcp,database}

# Create main server
cat > src/server.ts << 'EOF'
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const JWT_SECRET = 'your-secret-key-change-in-production';
const deviceConnections = new Map<string, any>();

// Mock database (replace with real PostgreSQL later)
const users = new Map();
const devices = new Map();

// Simple auth middleware
const auth = (req: any, res: any, next: any) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Auth routes (simplified - no Ory for now)
app.post('/auth/login', (req, res) => {
  const { email, name } = req.body;
  
  if (!users.has(email)) {
    users.set(email, { id: `user-${Date.now()}`, email, name });
  }
  
  const user = users.get(email);
  const token = jwt.sign(user, JWT_SECRET);
  
  res.json({ token, user });
});

// Device routes
app.get('/api/device', auth, (req: any, res) => {
  const userDevices = Array.from(devices.values())
    .filter((device: any) => device.userId === req.user.id);
  
  if (userDevices.length === 0) {
    return res.status(404).json({ error: 'No device found' });
  }
  
  res.json(userDevices[0]);
});

app.post('/api/device/register', auth, (req: any, res) => {
  const { name } = req.body;
  const userId = req.user.id;
  
  // Check if user already has a device (MVP: only one device)
  const existing = Array.from(devices.values())
    .find((device: any) => device.userId === userId);
  
  if (existing) {
    return res.status(400).json({ error: 'Device already registered' });
  }
  
  const deviceId = `device-${Date.now()}`;
  const device = {
    id: deviceId,
    userId,
    name,
    status: 'offline',
    createdAt: new Date()
  };
  
  devices.set(deviceId, device);
  
  const deviceToken = jwt.sign({ deviceId, userId }, JWT_SECRET);
  
  res.json({
    deviceId,
    deviceToken,
    websocketUrl: `ws://localhost:3000/ws`
  });
});

// MCP execution
app.post('/api/mcp/execute', auth, async (req: any, res) => {
  const userId = req.user.id;
  const mcpRequest = req.body;
  
  // Find user's device
  const device = Array.from(devices.values())
    .find((d: any) => d.userId === userId);
  
  if (!device || device.status !== 'online') {
    return res.status(400).json({ error: 'Device not available' });
  }
  
  const ws = deviceConnections.get(device.id);
  if (!ws) {
    return res.status(400).json({ error: 'Device not connected' });
  }
  
  // Send request to device and wait for response
  const requestId = `req-${Date.now()}`;
  const message = {
    id: requestId,
    type: 'mcp_request',
    payload: { ...mcpRequest, id: requestId }
  };
  
  ws.send(JSON.stringify(message));
  
  // Simple timeout for response (in real app, use proper promise handling)
  setTimeout(() => {
    res.json({ 
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result: { message: 'Mock response - device integration needed' }
    });
  }, 100);
});

// WebSocket handling
wss.on('connection', (ws, req) => {
  console.log('WebSocket connection attempted');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'device_auth') {
        const { deviceToken } = message;
        try {
          const { deviceId, userId } = jwt.verify(deviceToken, JWT_SECRET) as any;
          
          // Update device status
          const device = devices.get(deviceId);
          if (device) {
            device.status = 'online';
            device.lastSeen = new Date();
            deviceConnections.set(deviceId, ws);
            console.log(`Device ${deviceId} connected`);
            
            ws.send(JSON.stringify({ type: 'auth_success', deviceId }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
  
  ws.on('close', () => {
    // Find and disconnect device
    for (const [deviceId, connection] of deviceConnections.entries()) {
      if (connection === ws) {
        const device = devices.get(deviceId);
        if (device) {
          device.status = 'offline';
        }
        deviceConnections.delete(deviceId);
        console.log(`Device ${deviceId} disconnected`);
        break;
      }
    }
  });
});

// Serve simple dashboard
app.use(express.static('public'));

server.listen(3000, () => {
  console.log('🚀 Remote MCP Server running on http://localhost:3000');
});
EOF

# Create simple web dashboard
mkdir -p public
cat > public/index.html << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Remote MCP MVP</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .section { margin: 30px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        button { padding: 10px 20px; margin: 10px 5px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
        input { padding: 8px; margin: 5px; width: 200px; }
        .status { padding: 10px; margin: 10px 0; border-radius: 4px; }
        .online { background: #d4edda; color: #155724; }
        .offline { background: #f8d7da; color: #721c24; }
        textarea { width: 100%; height: 100px; margin: 10px 0; }
        pre { background: #f5f5f5; padding: 10px; border-radius: 4px; overflow: auto; }
    </style>
</head>
<body>
    <h1>Remote MCP MVP</h1>
    
    <div class="section">
        <h2>Authentication</h2>
        <input type="email" id="email" placeholder="Email" value="test@example.com">
        <input type="text" id="name" placeholder="Name" value="Test User">
        <button onclick="login()">Login</button>
        <div id="auth-status"></div>
    </div>
    
    <div class="section" id="device-section" style="display: none;">
        <h2>Device Management</h2>
        <div id="device-info"></div>
        <div id="register-form">
            <input type="text" id="device-name" placeholder="Device Name" value="My Computer">
            <button onclick="registerDevice()">Register Device</button>
        </div>
    </div>
    
    <div class="section" id="test-section" style="display: none;">
        <h2>Test MCP</h2>
        <textarea id="mcp-request">{"jsonrpc":"2.0","id":"1","method":"read_file","params":{"path":"/etc/hostname"}}</textarea>
        <button onclick="testMCP()">Execute MCP Request</button>
        <pre id="mcp-result"></pre>
    </div>

    <script>
        let authToken = null;
        
        async function login() {
            const email = document.getElementById('email').value;
            const name = document.getElementById('name').value;
            
            const response = await fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, name })
            });
            
            const data = await response.json();
            authToken = data.token;
            
            document.getElementById('auth-status').innerHTML = 
                '<div class="status online">Logged in as ' + data.user.name + '</div>';
            document.getElementById('device-section').style.display = 'block';
            
            loadDevice();
        }
        
        async function loadDevice() {
            const response = await fetch('/api/device', {
                headers: { Authorization: `Bearer ${authToken}` }
            });
            
            if (response.ok) {
                const device = await response.json();
                showDevice(device);
            }
        }
        
        function showDevice(device) {
            document.getElementById('device-info').innerHTML = 
                `<div class="status ${device.status}">
                    Device: ${device.name} (${device.status})
                </div>`;
            document.getElementById('register-form').style.display = 'none';
            document.getElementById('test-section').style.display = 'block';
        }
        
        async function registerDevice() {
            const name = document.getElementById('device-name').value;
            
            const response = await fetch('/api/device/register', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authToken}`
                },
                body: JSON.stringify({ name })
            });
            
            const data = await response.json();
            alert('Device registered! Token: ' + data.deviceToken);
            loadDevice();
        }
        
        async function testMCP() {
            const request = JSON.parse(document.getElementById('mcp-request').value);
            
            const response = await fetch('/api/mcp/execute', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authToken}`
                },
                body: JSON.stringify(request)
            });
            
            const result = await response.json();
            document.getElementById('mcp-result').textContent = JSON.stringify(result, null, 2);
        }
    </script>
</body>
</html>
EOF

# Add npm scripts
cat > package.json << 'EOF'
{
  "name": "remote-mcp-mvp",
  "version": "1.0.0",
  "scripts": {
    "dev": "nodemon src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "morgan": "^1.10.0",
    "ws": "^8.14.2",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.11.3",
    "uuid": "^9.0.1",
    "@ory/kratos-client": "^1.0.0",
    "@ory/hydra-client": "^2.2.0"
  },
  "devDependencies": {
    "typescript": "^5.2.2",
    "@types/node": "^20.8.0",
    "@types/express": "^4.17.0",
    "@types/ws": "^8.5.0",
    "ts-node": "^10.9.0",
    "nodemon": "^3.0.0"
  }
}
EOF
```

### 4. Run the MVP
```bash
# Install dependencies
npm install

# Start the server
npm run dev

# Open browser
open http://localhost:3000
```

## Test the MVP

1. **Login**: Use the web interface to login (any email works)
2. **Register Device**: Click "Register Device" and note the token
3. **Connect Device**: Use the token to connect a test WebSocket client
4. **Test MCP**: Try executing an MCP request

## Device Connection Test

Create a simple device simulator:

```bash
cat > test-device.js << 'EOF'
const WebSocket = require('ws');

// Use the device token from the web interface
const deviceToken = 'YOUR_DEVICE_TOKEN_HERE';

const ws = new WebSocket('ws://localhost:3000/ws');

ws.on('open', () => {
    console.log('Connected to server');
    
    // Authenticate as device
    ws.send(JSON.stringify({
        type: 'device_auth',
        deviceToken: deviceToken
    }));
});

ws.on('message', (data) => {
    const message = JSON.parse(data);
    console.log('Received:', message);
    
    if (message.type === 'mcp_request') {
        // Mock response
        const response = {
            id: message.id,
            type: 'mcp_response',
            payload: {
                jsonrpc: '2.0',
                id: message.payload.id,
                result: { content: 'Mock file content from device' }
            }
        };
        
        setTimeout(() => {
            ws.send(JSON.stringify(response));
        }, 100);
    }
});

ws.on('close', () => {
    console.log('Disconnected from server');
});
EOF

# Run device simulator
node test-device.js
```

## Next Steps

1. **Add Real PostgreSQL**: Replace mock database with PostgreSQL
2. **Integrate Ory**: Add real OAuth with Kratos/Hydra
3. **Enhance Device Agent**: Integrate with existing Desktop Commander
4. **Add Error Handling**: Improve error handling and timeouts
5. **Deploy**: Deploy to a VPS or cloud service

## Files Created

```
remote-mcp-mvp/
├── package.json
├── tsconfig.json
├── docker-compose.yml
├── src/
│   └── server.ts
├── public/
│   └── index.html
└── test-device.js
```

This gets you a working Remote MCP prototype in 30 minutes! 🎉