# Supabase OAuth MCP Server Implementation Plan

## Overview

Create a remote MCP server that uses Supabase for OAuth authentication with Server-Sent Events (SSE) transport. The system will provide a web-based signup/signin interface and handle OAuth flows through Supabase's authentication system.

## System Architecture

```
Claude Desktop ↔ SSE Client ↔ Supabase OAuth MCP Server ↔ Supabase Auth
                                         ↕
                              Web Signup/Signin Interface
```

### Components

1. **Supabase OAuth MCP Server** - Main MCP server with SSE transport
2. **Web Authentication Interface** - Simple signup/signin web app
3. **SSE Client Connector** - Handles SSE connection to MCP server
4. **Supabase Integration** - OAuth provider and user management

## Technical Specifications

### Environment Configuration

```env
# Supabase Configuration
SUPABASE_URL=https://olvbkozcufcbptfogatw.supabase.co
SUPABASE_ANON_KEY=sb_publishable_unw3vAjM8B96rGPakw6-6w_plDKk4ag
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sdmJrb3pjdWZjYnB0Zm9nYXR3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Njk5Njc4NSwiZXhwIjoyMDgyNTcyNzg1fQ.ZMNK4khZSD0dgXuYWmFj0C3Jzyo6eOt9w3-03hmbidc

# Server Configuration
MCP_SERVER_PORT=3007
MCP_SERVER_HOST=localhost
ENABLE_HTTPS=false

# OAuth Configuration
OAUTH_REDIRECT_URL=http://localhost:3008/auth/callback
WEB_APP_URL=http://localhost:3008
ALLOWED_ORIGINS=["http://localhost:3008"]

# Session Configuration
SESSION_SECRET=your-session-secret-change-in-production
JWT_SECRET=your-jwt-secret-change-in-production

# CORS and Security
CORS_ORIGINS=["http://localhost:3008", "http://localhost:3002"]
DEMO_MODE=true
```

### Database Schema (Supabase)

```sql
-- Enable RLS
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

-- MCP Sessions table
CREATE TABLE public.mcp_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL,
  client_info JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours'),
  is_active BOOLEAN DEFAULT true
);

-- MCP Tools Usage Log
CREATE TABLE public.mcp_tool_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES public.mcp_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  parameters JSONB,
  result JSONB,
  duration_ms INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  success BOOLEAN DEFAULT true,
  error_message TEXT
);

-- RLS Policies
CREATE POLICY "Users can view their own sessions" ON public.mcp_sessions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own sessions" ON public.mcp_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sessions" ON public.mcp_sessions
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own tool calls" ON public.mcp_tool_calls
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "System can insert tool calls" ON public.mcp_tool_calls
  FOR INSERT WITH CHECK (true);
```

## Implementation Structure

```
supabase-mcp/
├── package.json
├── .env.example
├── src/
│   ├── server/
│   │   ├── mcp-server.js          # Main MCP SSE server
│   │   ├── auth-middleware.js     # Supabase auth middleware
│   │   ├── sse-manager.js         # SSE connection management
│   │   └── tools/
│   │       ├── echo.js            # Example echo tool
│   │       ├── user-info.js       # User information tool
│   │       └── supabase-query.js  # Supabase data tool
│   ├── web/
│   │   ├── app.js                 # Express web server
│   │   ├── public/
│   │   │   ├── index.html         # Landing page
│   │   │   ├── auth.html          # Login/signup page
│   │   │   ├── success.html       # Success page
│   │   │   ├── style.css          # Styling
│   │   │   └── auth.js            # Frontend auth logic
│   │   └── routes/
│   │       ├── auth.js            # Auth routes
│   │       └── callback.js        # OAuth callback
│   ├── client/
│   │   └── sse-connector.js       # SSE MCP client connector
│   └── utils/
│       ├── supabase.js            # Supabase client setup
│       ├── logger.js              # Logging utility
│       └── crypto.js              # Token generation
├── config/
│   └── mcp_config.json           # Claude Desktop config
├── test/
│   ├── auth-flow.test.js         # Authentication tests
│   ├── mcp-tools.test.js         # MCP tools tests
│   └── sse-connection.test.js    # SSE connection tests
└── docs/
    ├── API.md                    # API documentation
    ├── SETUP.md                  # Setup instructions
    └── DEPLOYMENT.md             # Deployment guide
```

## Implementation Phases

### Phase 1: Core Infrastructure (Day 1)

#### 1.1 Project Setup
- Initialize Node.js project with TypeScript/ES6
- Install dependencies:
  ```json
  {
    "@supabase/supabase-js": "^2.x",
    "express": "^4.x",
    "cors": "^2.x",
    "eventsource": "^2.x",
    "@modelcontextprotocol/sdk": "^1.x",
    "uuid": "^9.x",
    "jsonwebtoken": "^9.x"
  }
  ```

#### 1.2 Supabase Configuration
- Set up Supabase client with URL and anon key
- Configure authentication settings in Supabase dashboard:
  - Enable email authentication
  - Configure redirect URLs
  - Set up RLS policies

#### 1.3 Basic MCP Server Structure
```javascript
// src/server/mcp-server.js
import express from 'express';
import cors from 'cors';
import { createSupabaseClient } from '../utils/supabase.js';
import { SSEManager } from './sse-manager.js';
import { AuthMiddleware } from './auth-middleware.js';

class SupabaseMCPServer {
  constructor() {
    this.app = express();
    this.port = process.env.MCP_SERVER_PORT || 3007;
    this.supabase = createSupabaseClient();
    this.sseManager = new SSEManager();
    this.authMiddleware = new AuthMiddleware(this.supabase);
  }
  
  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => { /* ... */ });
    
    // SSE endpoint with auth
    this.app.get('/sse', this.authMiddleware.validate, this.sseManager.handleConnection);
    
    // MCP message endpoint
    this.app.post('/mcp', this.authMiddleware.validate, this.handleMCPMessage);
  }
}
```

### Phase 2: Authentication System (Day 2)

#### 2.1 Supabase Auth Middleware
```javascript
// src/server/auth-middleware.js
export class AuthMiddleware {
  constructor(supabase) {
    this.supabase = supabase;
  }
  
  async validate(req, res, next) {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '');
      
      const { data: { user }, error } = await this.supabase.auth.getUser(token);
      
      if (error || !user) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      
      req.user = user;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Authentication failed' });
    }
  }
}
```

#### 2.2 Web Authentication Interface
```html
<!-- src/web/public/auth.html -->
<!DOCTYPE html>
<html>
<head>
  <title>Supabase MCP Authentication</title>
  <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
</head>
<body>
  <div class="auth-container">
    <h1>MCP Server Authentication</h1>
    
    <div id="login-form">
      <h2>Sign In</h2>
      <form id="signin-form">
        <input type="email" id="email" placeholder="Email" required>
        <input type="password" id="password" placeholder="Password" required>
        <button type="submit">Sign In</button>
      </form>
      
      <p><a href="#" id="show-signup">Need an account? Sign up</a></p>
    </div>
    
    <div id="signup-form" style="display: none;">
      <h2>Sign Up</h2>
      <form id="register-form">
        <input type="email" id="signup-email" placeholder="Email" required>
        <input type="password" id="signup-password" placeholder="Password" required>
        <button type="submit">Sign Up</button>
      </form>
      
      <p><a href="#" id="show-signin">Already have an account? Sign in</a></p>
    </div>
  </div>
  
  <script src="auth.js"></script>
</body>
</html>
```

### Phase 3: SSE Implementation (Day 3)

#### 3.1 SSE Connection Manager
```javascript
// src/server/sse-manager.js
export class SSEManager {
  constructor() {
    this.connections = new Map(); // userId -> SSE connection
  }
  
  handleConnection = (req, res) => {
    const userId = req.user.id;
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization'
    });
    
    // Store connection
    this.connections.set(userId, res);
    
    // Send initial connection message
    this.sendMessage(userId, 'connected', { 
      message: 'MCP SSE connection established',
      userId: userId
    });
    
    // Handle disconnect
    req.on('close', () => {
      this.connections.delete(userId);
    });
  };
  
  sendMessage(userId, type, data) {
    const connection = this.connections.get(userId);
    if (connection) {
      connection.write(`event: ${type}\n`);
      connection.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }
  
  broadcastMCPMessage(userId, mcpMessage) {
    this.sendMessage(userId, 'mcp-message', mcpMessage);
  }
}
```

#### 3.2 MCP Message Handler
```javascript
// MCP message handling in mcp-server.js
async handleMCPMessage(req, res) {
  try {
    const { jsonrpc, id, method, params } = req.body;
    const userId = req.user.id;
    
    // Validate JSON-RPC format
    if (jsonrpc !== '2.0' || !method) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request' }
      });
    }
    
    // Handle MCP methods
    let result;
    switch (method) {
      case 'initialize':
        result = await this.handleInitialize(params, userId);
        break;
      case 'tools/list':
        result = await this.handleToolsList(userId);
        break;
      case 'tools/call':
        result = await this.handleToolCall(params, userId);
        break;
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    
    // Send response via SSE
    this.sseManager.broadcastMCPMessage(userId, {
      jsonrpc: '2.0',
      id,
      result
    });
    
    // Also send HTTP response
    res.json({ jsonrpc: '2.0', id, result });
    
  } catch (error) {
    const errorResponse = {
      jsonrpc: '2.0',
      id: req.body?.id,
      error: { code: -32603, message: error.message }
    };
    
    this.sseManager.broadcastMCPMessage(req.user.id, errorResponse);
    res.status(500).json(errorResponse);
  }
}
```

### Phase 4: MCP Tools Implementation (Day 4)

#### 4.1 Core Tools
```javascript
// src/server/tools/user-info.js
export class UserInfoTool {
  static getDefinition() {
    return {
      name: 'user_info',
      description: 'Get current user information from Supabase',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    };
  }
  
  static async execute(params, user, supabase) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: user.id,
          email: user.email,
          created_at: user.created_at,
          last_sign_in: user.last_sign_in_at
        }, null, 2)
      }]
    };
  }
}

// src/server/tools/supabase-query.js
export class SupabaseQueryTool {
  static getDefinition() {
    return {
      name: 'supabase_query',
      description: 'Execute a Supabase query (read-only)',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          columns: { type: 'string', description: 'Columns to select (default: *)' },
          filters: { type: 'object', description: 'Filter conditions' },
          limit: { type: 'number', description: 'Limit results' }
        },
        required: ['table']
      }
    };
  }
  
  static async execute(params, user, supabase) {
    const { table, columns = '*', filters = {}, limit = 10 } = params;
    
    let query = supabase.from(table).select(columns);
    
    // Apply filters
    Object.entries(filters).forEach(([key, value]) => {
      query = query.eq(key, value);
    });
    
    if (limit) query = query.limit(limit);
    
    const { data, error } = await query;
    
    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }]
    };
  }
}
```

### Phase 5: Client Connector (Day 5)

#### 5.1 SSE MCP Client
```javascript
// src/client/sse-connector.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import EventSource from 'eventsource';

export class SupabaseSSEConnector {
  constructor() {
    this.mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3007';
    this.accessToken = null;
    this.eventSource = null;
    this.pendingRequests = new Map();
    
    this.server = new Server({
      name: 'supabase-sse-connector',
      version: '1.0.0'
    }, {
      capabilities: { tools: {} }
    });
    
    this.setupHandlers();
  }
  
  async authenticate() {
    // In production, this would handle the OAuth flow
    // For demo, we'll use a stored token or environment variable
    this.accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    
    if (!this.accessToken) {
      throw new Error('No access token available. Please authenticate first.');
    }
  }
  
  connectSSE() {
    this.eventSource = new EventSource(`${this.mcpServerUrl}/sse`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });
    
    this.eventSource.addEventListener('mcp-message', (event) => {
      const message = JSON.parse(event.data);
      this.handleMCPResponse(message);
    });
    
    this.eventSource.addEventListener('error', (error) => {
      console.error('SSE connection error:', error);
    });
  }
  
  async sendMCPRequest(method, params) {
    const id = Math.random().toString(36).substring(7);
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    
    // Send HTTP request
    const response = await fetch(`${this.mcpServerUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`
      },
      body: JSON.stringify(request)
    });
    
    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.status}`);
    }
    
    return response.json();
  }
  
  setupHandlers() {
    this.server.setRequestHandler('tools/list', async () => {
      const response = await this.sendMCPRequest('tools/list', {});
      return response.result;
    });
    
    this.server.setRequestHandler('tools/call', async (request) => {
      const response = await this.sendMCPRequest('tools/call', request.params);
      return response.result;
    });
  }
  
  async start() {
    await this.authenticate();
    this.connectSSE();
    
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
```

## Web Interface Implementation

### Frontend Authentication Flow

```javascript
// src/web/public/auth.js
const supabase = window.supabase.createClient(
  'https://olvbkozcufcbptfogatw.supabase.co',
  'sb_publishable_unw3vAjM8B96rGPakw6-6w_plDKk4ag'
);

class AuthManager {
  constructor() {
    this.initEventListeners();
    this.checkExistingSession();
  }
  
  async checkExistingSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      this.handleAuthSuccess(session);
    }
  }
  
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`
      }
    });
    
    if (error) {
      this.showError(error.message);
      return;
    }
    
    this.showMessage('Check your email for verification link');
  }
  
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    
    if (error) {
      this.showError(error.message);
      return;
    }
    
    this.handleAuthSuccess(data.session);
  }
  
  handleAuthSuccess(session) {
    // Store token for MCP access
    localStorage.setItem('supabase_access_token', session.access_token);
    localStorage.setItem('supabase_refresh_token', session.refresh_token);
    
    // Show success and connection info
    this.showConnectionInfo(session.access_token);
  }
  
  showConnectionInfo(token) {
    document.body.innerHTML = `
      <div class="success-container">
        <h1>✅ Authentication Successful!</h1>
        <h2>MCP Connection Information</h2>
        
        <div class="config-section">
          <h3>For Claude Desktop (mcp_config.json):</h3>
          <pre><code>{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": ["sse-connector.js"],
      "env": {
        "MCP_SERVER_URL": "http://localhost:3007",
        "SUPABASE_ACCESS_TOKEN": "${token}"
      }
    }
  }
}</code></pre>
        </div>
        
        <div class="token-section">
          <h3>Access Token (expires in 1 hour):</h3>
          <code class="token">${token}</code>
          <button onclick="copyToken('${token}')">Copy Token</button>
        </div>
        
        <button onclick="testConnection()">Test MCP Connection</button>
      </div>
    `;
  }
}
```

## Testing Strategy

### 1. Unit Tests
```javascript
// test/auth-flow.test.js
describe('Supabase Authentication', () => {
  test('should authenticate user with valid credentials', async () => {
    // Test implementation
  });
  
  test('should reject invalid credentials', async () => {
    // Test implementation
  });
});
```

### 2. Integration Tests
```javascript
// test/mcp-tools.test.js
describe('MCP Tools', () => {
  test('should list available tools', async () => {
    // Test implementation
  });
  
  test('should execute user_info tool', async () => {
    // Test implementation
  });
});
```

### 3. SSE Connection Tests
```javascript
// test/sse-connection.test.js
describe('SSE Connection', () => {
  test('should establish SSE connection with valid token', async () => {
    // Test implementation
  });
  
  test('should handle SSE disconnection gracefully', async () => {
    // Test implementation
  });
});
```

## Deployment Guide

### Development Setup
1. Clone repository
2. Install dependencies: `npm install`
3. Configure environment variables
4. Set up Supabase database schema
5. Start servers: `npm run dev`

### Production Deployment
1. Configure Supabase production settings
2. Set up HTTPS with proper certificates
3. Deploy to cloud provider (Vercel, Railway, etc.)
4. Configure domain and CORS settings

## Security Considerations

1. **Token Management**: Implement proper token refresh and rotation
2. **CORS Configuration**: Restrict origins to trusted domains
3. **Rate Limiting**: Implement request rate limiting
4. **Input Validation**: Validate all MCP tool inputs
5. **RLS Policies**: Ensure proper Row Level Security in Supabase
6. **HTTPS**: Use HTTPS in production
7. **Session Management**: Implement proper session timeout and cleanup

## Future Enhancements

1. **Multi-tenant Support**: Support for organizations/teams
2. **Tool Marketplace**: Dynamic tool loading and management
3. **Analytics Dashboard**: Usage analytics and monitoring
4. **Mobile App**: React Native app for mobile access
5. **Webhooks**: Integration with external services
6. **Real-time Collaboration**: Multi-user MCP sessions

## Timeline

- **Day 1**: Project setup and core infrastructure
- **Day 2**: Authentication system and web interface
- **Day 3**: SSE implementation and connection management
- **Day 4**: MCP tools and business logic
- **Day 5**: Client connector and testing
- **Day 6**: Documentation and deployment
- **Day 7**: Testing and refinement

## Success Criteria

1. ✅ User can sign up/sign in via web interface
2. ✅ Supabase authentication integration works
3. ✅ SSE connection established with authenticated users
4. ✅ MCP tools accessible via SSE transport
5. ✅ Claude Desktop integration works with connector
6. ✅ Proper error handling and logging
7. ✅ Comprehensive test coverage
8. ✅ Production-ready deployment configuration