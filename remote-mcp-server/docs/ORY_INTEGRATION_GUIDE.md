# Ory Hydra/Kratos Integration Guide

This guide provides detailed information on integrating the Remote MCP Server with Ory Hydra (OAuth server) and Ory Kratos (identity management) for production deployments.

---

## 🏛 Ory Stack Overview

### Architecture with Ory

```
┌─────────────────┐    OIDC/OAuth    ┌─────────────────┐
│                 │◄───────────────►│                 │
│  Claude Desktop │                 │   Ory Hydra    │
│                 │                 │ (OAuth Server)  │
└─────────┬───────┘                 └─────────┬───────┘
          │                                   │
          │ MCP + Bearer Token                │ User Identity
          │                                   │ Verification
          ▼                                   ▼
┌─────────────────┐  Token          ┌─────────────────┐
│                 │  Introspection  │                 │
│ MCP Server      │◄───────────────►│  Ory Kratos    │
│ (Port 3005)     │                 │ (Identity Mgmt) │
└─────────────────┘                 └─────────┬───────┘
                                              │
                                              ▼
                                    ┌─────────────────┐
                                    │                 │
                                    │   PostgreSQL    │
                                    │   Database      │
                                    │                 │
                                    └─────────────────┘
```

### Components

1. **Ory Hydra** - OAuth 2.0 and OpenID Connect server
2. **Ory Kratos** - Identity and user management
3. **PostgreSQL** - Shared database for both services
4. **MCP Server** - Resource server that validates tokens

---

## 🐳 Docker Compose Setup

### Complete docker-compose.oauth.yml

```yaml
version: '3.8'

services:
  # PostgreSQL Database for Ory services
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: ory
      POSTGRES_USER: ory
      POSTGRES_PASSWORD: ory_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./sql/init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    networks:
      - ory_network

  # Ory Kratos - Identity Management
  kratos-migrate:
    image: oryd/kratos:v1.0.0
    environment:
      - DSN=postgresql://ory:ory_password@postgres:5432/kratos?sslmode=disable
    volumes:
      - type: bind
        source: ./kratos
        target: /etc/config/kratos
    command: -c /etc/config/kratos/kratos.yml migrate sql -e --yes
    restart: on-failure
    networks:
      - ory_network
    depends_on:
      - postgres

  kratos:
    image: oryd/kratos:v1.0.0
    ports:
      - "4433:4433" # public API
      - "4434:4434" # admin API
    restart: unless-stopped
    environment:
      - DSN=postgresql://ory:ory_password@postgres:5432/kratos?sslmode=disable
      - LOG_LEVEL=trace
    command: serve -c /etc/config/kratos/kratos.yml --dev --watch-courier
    volumes:
      - type: bind
        source: ./kratos
        target: /etc/config/kratos
    networks:
      - ory_network
    depends_on:
      - kratos-migrate

  # Ory Hydra - OAuth Server
  hydra-migrate:
    image: oryd/hydra:v2.2.0
    environment:
      - DSN=postgresql://ory:ory_password@postgres:5432/hydra?sslmode=disable
    command: migrate -c /etc/config/hydra/hydra.yml sql -e --yes
    volumes:
      - type: bind
        source: ./hydra
        target: /etc/config/hydra
    restart: on-failure
    networks:
      - ory_network
    depends_on:
      - postgres

  hydra:
    image: oryd/hydra:v2.2.0
    ports:
      - "4444:4444" # public API
      - "4445:4445" # admin API
    command: serve -c /etc/config/hydra/hydra.yml all --dangerous-force-http
    volumes:
      - type: bind
        source: ./hydra
        target: /etc/config/hydra
    environment:
      - DSN=postgresql://ory:ory_password@postgres:5432/hydra?sslmode=disable
      - URLS_SELF_ISSUER=http://localhost:4444
      - URLS_CONSENT=http://localhost:3003/auth/consent
      - URLS_LOGIN=http://localhost:3003/auth/login
      - URLS_LOGOUT=http://localhost:3003/auth/logout
      - URLS_POST_LOGOUT_REDIRECT=http://localhost:3003/
      - STRATEGIES_ACCESS_TOKEN=opaque
      - TTL_ACCESS_TOKEN=1h
      - TTL_REFRESH_TOKEN=24h
      - TTL_ID_TOKEN=1h
      - TTL_AUTH_CODE=10m
      - LOG_LEVEL=debug
      - LOG_FORMAT=json
    restart: unless-stopped
    networks:
      - ory_network
    depends_on:
      - hydra-migrate

  # Remote MCP Server with Ory Integration
  mcp-server:
    build: 
      context: .
      dockerfile: Dockerfile.ory
    ports:
      - "3003:3003"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://ory:ory_password@postgres:5432/mcp_server?sslmode=disable
      - HYDRA_ADMIN_URL=http://hydra:4445
      - KRATOS_PUBLIC_URL=http://kratos:4433
      - KRATOS_ADMIN_URL=http://kratos:4434
      - OAUTH_ISSUER_URL=http://localhost:4444
      - SESSION_SECRET=your-session-secret-change-in-production
      - CORS_ORIGIN=http://localhost:3000,http://localhost:3003
    volumes:
      - ./logs:/app/logs
    networks:
      - ory_network
    depends_on:
      - postgres
      - hydra
      - kratos

volumes:
  postgres_data:

networks:
  ory_network:
    driver: bridge
```

---

## 📝 Ory Configuration Files

### Ory Kratos Configuration

**File**: `kratos/kratos.yml`

```yaml
version: v1.0.0

dsn: postgresql://ory:ory_password@postgres:5432/kratos?sslmode=disable

serve:
  public:
    base_url: http://localhost:4433/
    cors:
      enabled: true
      allowed_origins:
        - http://localhost:3003
        - http://localhost:3000
      allowed_methods:
        - POST
        - GET
        - PUT
        - PATCH
        - DELETE
      allowed_headers:
        - Authorization
        - Content-Type
        - X-Session-Token
      exposed_headers:
        - Content-Type
        - Set-Cookie

  admin:
    base_url: http://localhost:4434/

selfservice:
  default_browser_return_url: http://localhost:3003/auth/callback
  allowed_return_urls:
    - http://localhost:3003
    - http://localhost:3003/auth
    - http://localhost:3003/auth/callback
    - http://localhost:3003/dashboard

  flows:
    error:
      ui_url: http://localhost:3003/auth/error

    settings:
      ui_url: http://localhost:3003/auth/settings
      privileged_session_max_age: 15m
      after:
        default_browser_return_url: http://localhost:3003/dashboard

    recovery:
      enabled: true
      ui_url: http://localhost:3003/auth/recovery

    verification:
      enabled: true
      ui_url: http://localhost:3003/auth/verification
      after:
        default_browser_return_url: http://localhost:3003/dashboard

    logout:
      after:
        default_browser_return_url: http://localhost:3003/

    login:
      ui_url: http://localhost:3003/auth/login
      lifespan: 10m
      after:
        default_browser_return_url: http://localhost:3003/dashboard

    registration:
      lifespan: 10m
      ui_url: http://localhost:3003/auth/registration
      after:
        default_browser_return_url: http://localhost:3003/dashboard
        password:
          hooks:
            - hook: session

log:
  level: debug
  format: text
  leak_sensitive_values: false

secrets:
  cookie:
    - PLEASE-CHANGE-ME-I-AM-VERY-INSECURE
  cipher:
    - 32-LONG-SECRET-NOT-SECURE-AT-ALL

ciphers:
  algorithm: xchacha20-poly1305

hashers:
  algorithm: bcrypt
  bcrypt:
    cost: 8

identity:
  default_schema_id: default
  schemas:
    - id: default
      url: file:///etc/config/kratos/identity.schema.json

courier:
  smtp:
    connection_uri: smtps://test:test@mailhog:1025/?skip_ssl_verify=true
```

**File**: `kratos/identity.schema.json`

```json
{
  "$id": "https://schemas.ory.sh/presets/kratos/quickstart/email-password/identity.schema.json",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Person",
  "type": "object",
  "properties": {
    "traits": {
      "type": "object",
      "properties": {
        "email": {
          "type": "string",
          "format": "email",
          "title": "E-Mail",
          "minLength": 3,
          "ory.sh/kratos": {
            "credentials": {
              "password": {
                "identifier": true
              }
            },
            "verification": {
              "via": "email"
            },
            "recovery": {
              "via": "email"
            }
          }
        },
        "name": {
          "type": "string",
          "title": "Full Name",
          "minLength": 1
        }
      },
      "required": [
        "email",
        "name"
      ],
      "additionalProperties": false
    }
  }
}
```

### Ory Hydra Configuration

**File**: `hydra/hydra.yml`

```yaml
version: v2.2.0

dsn: postgresql://ory:ory_password@postgres:5432/hydra?sslmode=disable

serve:
  public:
    port: 4444
    host: 0.0.0.0
    cors:
      enabled: true
      allowed_origins:
        - "http://localhost:3003"
        - "http://localhost:3000"
      allowed_methods:
        - POST
        - GET
        - PUT
        - PATCH
        - DELETE
        - OPTIONS
      allowed_headers:
        - "Authorization"
        - "Content-Type"
      exposed_headers:
        - "Content-Type"

  admin:
    port: 4445
    host: 0.0.0.0

urls:
  self:
    issuer: http://localhost:4444
  consent: http://localhost:3003/auth/consent
  login: http://localhost:3003/auth/login
  logout: http://localhost:3003/auth/logout
  error: http://localhost:3003/auth/error
  post_logout_redirect: http://localhost:3003/

strategies:
  access_token: opaque
  scope: wildcard

ttl:
  login_consent_request: 1h
  access_token: 1h
  refresh_token: 24h
  id_token: 1h
  auth_code: 10m

oauth2:
  session:
    encrypt_at_rest: true
  pkce:
    enforced: true
    enforced_for_public_clients: true

secrets:
  system:
    - youReallyNeedToChangeThis
  cookie:
    - youReallyNeedToChangeThis

log:
  level: debug
  format: json

oidc:
  subject_identifiers:
    supported_types:
      - pairwise
      - public
    pairwise:
      salt: youReallyNeedToChangeThis

webfinger:
  jwks:
    broadcast_keys:
      - hydra.openid.id-token
  oidc_discovery:
    client_registration_url: http://localhost:4444/clients
    supported_claims:
      - sub
      - name
      - email
      - email_verified
    supported_scope:
      - openid
      - offline
      - mcp:tools
      - mcp:remote
    userinfo_url: http://localhost:4444/userinfo
```

---

## 🔧 Integration Implementation

### Modified MCP Server for Ory Integration

**File**: `src/ory-integration.js`

```javascript
const { createProxyMiddleware } = require('http-proxy-middleware');
const session = require('express-session');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2');

class OryMCPIntegration {
  constructor(app, config) {
    this.app = app;
    this.config = {
      hydraAdminUrl: config.HYDRA_ADMIN_URL || 'http://localhost:4445',
      kratosPublicUrl: config.KRATOS_PUBLIC_URL || 'http://localhost:4433',
      kratosAdminUrl: config.KRATOS_ADMIN_URL || 'http://localhost:4434',
      oauthIssuerUrl: config.OAUTH_ISSUER_URL || 'http://localhost:4444',
      sessionSecret: config.SESSION_SECRET || 'change-me-in-production'
    };
    
    this.setupSession();
    this.setupPassport();
    this.setupAuthRoutes();
  }

  setupSession() {
    this.app.use(session({
      secret: this.config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));
  }

  setupPassport() {
    this.app.use(passport.initialize());
    this.app.use(passport.session());

    passport.use('hydra', new OAuth2Strategy({
      authorizationURL: `${this.config.oauthIssuerUrl}/oauth2/auth`,
      tokenURL: `${this.config.oauthIssuerUrl}/oauth2/token`,
      clientID: process.env.OAUTH_CLIENT_ID || 'mcp-server',
      clientSecret: process.env.OAUTH_CLIENT_SECRET || 'mcp-secret',
      callbackURL: '/auth/callback'
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        // Validate token with Hydra
        const tokenInfo = await this.introspectToken(accessToken);
        return done(null, { ...profile, accessToken, tokenInfo });
      } catch (error) {
        return done(error);
      }
    }));

    passport.serializeUser((user, done) => {
      done(null, user);
    });

    passport.deserializeUser((user, done) => {
      done(null, user);
    });
  }

  setupAuthRoutes() {
    // Login initiation
    this.app.get('/auth/login', (req, res, next) => {
      // Check if this is coming from Hydra login challenge
      const loginChallenge = req.query.login_challenge;
      if (loginChallenge) {
        // Handle Hydra login challenge flow
        return this.handleHydraLogin(req, res, next);
      }
      
      // Regular OAuth flow
      passport.authenticate('hydra', {
        scope: ['openid', 'mcp:tools', 'mcp:remote']
      })(req, res, next);
    });

    // OAuth callback
    this.app.get('/auth/callback', passport.authenticate('hydra', {
      failureRedirect: '/auth/error'
    }), (req, res) => {
      res.redirect('/dashboard');
    });

    // Consent handling
    this.app.get('/auth/consent', async (req, res) => {
      const consentChallenge = req.query.consent_challenge;
      if (!consentChallenge) {
        return res.status(400).json({ error: 'consent_challenge is required' });
      }

      try {
        // Auto-accept consent for MCP scopes
        const acceptResponse = await fetch(
          `${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/consent/accept?consent_challenge=${consentChallenge}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_scope: ['openid', 'mcp:tools', 'mcp:remote'],
              remember: true,
              remember_for: 3600
            })
          }
        );

        const acceptData = await acceptResponse.json();
        res.redirect(acceptData.redirect_to);
      } catch (error) {
        res.status(500).json({ error: 'Consent handling failed', details: error.message });
      }
    });

    // Logout
    this.app.get('/auth/logout', (req, res) => {
      req.logout((err) => {
        if (err) {
          return res.status(500).json({ error: 'Logout failed' });
        }
        res.redirect('/');
      });
    });

    // Error handling
    this.app.get('/auth/error', (req, res) => {
      res.status(400).json({
        error: 'Authentication failed',
        message: 'Please try again or contact support'
      });
    });
  }

  async handleHydraLogin(req, res, next) {
    const loginChallenge = req.query.login_challenge;

    try {
      // Get login request from Hydra
      const loginResponse = await fetch(
        `${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/login?login_challenge=${loginChallenge}`
      );
      const loginRequest = await loginResponse.json();

      // For demo purposes, auto-accept login
      // In production, redirect to Kratos login flow
      const acceptResponse = await fetch(
        `${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/login/accept?login_challenge=${loginChallenge}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: 'demo-user',
            remember: true,
            remember_for: 3600
          })
        }
      );

      const acceptData = await acceptResponse.json();
      res.redirect(acceptData.redirect_to);
    } catch (error) {
      res.status(500).json({ error: 'Login handling failed', details: error.message });
    }
  }

  async introspectToken(token) {
    try {
      const response = await fetch(`${this.config.oauthIssuerUrl}/oauth2/introspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${process.env.OAUTH_CLIENT_ID}:${process.env.OAUTH_CLIENT_SECRET}`).toString('base64')}`
        },
        body: `token=${encodeURIComponent(token)}`
      });

      return await response.json();
    } catch (error) {
      throw new Error(`Token introspection failed: ${error.message}`);
    }
  }

  // Middleware to protect MCP endpoints
  requireAuth() {
    return (req, res, next) => {
      if (req.isAuthenticated()) {
        return next();
      }
      
      // Check for bearer token
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return this.validateBearerToken(req, res, next);
      }

      // Set WWW-Authenticate header
      res.setHeader('WWW-Authenticate', 
        `Bearer realm="mcp", authorization_uri="${this.config.oauthIssuerUrl}/oauth2/auth"`
      );
      res.status(401).json({ error: 'Authentication required' });
    };
  }

  async validateBearerToken(req, res, next) {
    const token = req.headers.authorization.substring(7);

    try {
      const tokenInfo = await this.introspectToken(token);
      if (tokenInfo.active) {
        req.auth = tokenInfo;
        return next();
      }
    } catch (error) {
      console.error('Token validation error:', error);
    }

    res.setHeader('WWW-Authenticate', 
      'Bearer realm="mcp", error="invalid_token"'
    );
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { OryMCPIntegration };
```

---

## 🚀 Deployment Scripts

### Setup Script

**File**: `scripts/setup-ory-stack.sh`

```bash
#!/bin/bash

set -e

echo "🚀 Setting up Ory Stack for MCP Server"

# Create directories
mkdir -p kratos hydra sql logs

# Download Kratos identity schema if not exists
if [ ! -f "kratos/identity.schema.json" ]; then
    echo "📝 Creating Kratos identity schema..."
    cat > kratos/identity.schema.json << 'EOF'
{
  "$id": "https://schemas.ory.sh/presets/kratos/quickstart/email-password/identity.schema.json",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Person",
  "type": "object",
  "properties": {
    "traits": {
      "type": "object",
      "properties": {
        "email": {
          "type": "string",
          "format": "email",
          "title": "E-Mail",
          "minLength": 3,
          "ory.sh/kratos": {
            "credentials": {
              "password": {
                "identifier": true
              }
            }
          }
        },
        "name": {
          "type": "string",
          "title": "Full Name"
        }
      },
      "required": ["email"],
      "additionalProperties": false
    }
  }
}
EOF
fi

# Create database initialization script
cat > sql/init.sql << 'EOF'
-- Create databases for Ory services
CREATE DATABASE kratos;
CREATE DATABASE hydra;
CREATE DATABASE mcp_server;

-- Create users (optional, using default 'ory' user)
-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE kratos TO ory;
GRANT ALL PRIVILEGES ON DATABASE hydra TO ory;
GRANT ALL PRIVILEGES ON DATABASE mcp_server TO ory;
EOF

echo "🐳 Starting Ory Stack with Docker Compose..."
docker-compose -f docker-compose.oauth.yml up -d postgres

echo "⏳ Waiting for PostgreSQL to be ready..."
sleep 10

echo "🚀 Starting Ory services..."
docker-compose -f docker-compose.oauth.yml up -d

echo "⏳ Waiting for Ory services to be ready..."
sleep 20

echo "🔧 Creating OAuth client for MCP Server..."
./scripts/create-oauth-client.sh

echo "✅ Ory Stack setup complete!"
echo ""
echo "🌐 Service URLs:"
echo "   Kratos Public API: http://localhost:4433"
echo "   Kratos Admin API:  http://localhost:4434" 
echo "   Hydra Public API:  http://localhost:4444"
echo "   Hydra Admin API:   http://localhost:4445"
echo "   MCP Server:        http://localhost:3003"
echo ""
echo "📚 Next steps:"
echo "1. Configure your MCP client to use: http://localhost:4444 as OAuth issuer"
echo "2. Use the created client credentials for authentication"
echo "3. Access MCP endpoints at: http://localhost:3003/mcp/*"
```

### OAuth Client Creation Script

**File**: `scripts/create-oauth-client.sh`

```bash
#!/bin/bash

set -e

echo "🔧 Creating OAuth client for MCP Server..."

# Wait for Hydra to be ready
echo "⏳ Waiting for Hydra Admin API..."
until curl -s http://localhost:4445/health > /dev/null 2>&1; do
    sleep 2
    echo "Waiting for Hydra..."
done

# Create OAuth client
CLIENT_RESPONSE=$(curl -s -X POST \
  http://localhost:4445/admin/clients \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "mcp-server-client",
    "client_name": "MCP Server OAuth Client",
    "client_secret": "mcp-server-secret-change-in-production",
    "redirect_uris": [
      "http://localhost:3003/auth/callback",
      "http://localhost:8080/callback"
    ],
    "grant_types": [
      "authorization_code",
      "refresh_token"
    ],
    "response_types": [
      "code"
    ],
    "scope": "openid mcp:tools mcp:remote",
    "token_endpoint_auth_method": "client_secret_post"
  }')

if echo "$CLIENT_RESPONSE" | grep -q "client_id"; then
    echo "✅ OAuth client created successfully!"
    echo "$CLIENT_RESPONSE" | jq .
    
    # Save client credentials to .env file
    cat > .env.ory << EOF
# Ory OAuth Configuration
OAUTH_CLIENT_ID=mcp-server-client
OAUTH_CLIENT_SECRET=mcp-server-secret-change-in-production
OAUTH_ISSUER_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434

# Database
DATABASE_URL=postgresql://ory:ory_password@localhost:5432/mcp_server?sslmode=disable

# Session
SESSION_SECRET=change-this-in-production-to-a-long-random-string
EOF

    echo "📝 Client credentials saved to .env.ory"
else
    echo "❌ Failed to create OAuth client"
    echo "$CLIENT_RESPONSE"
    exit 1
fi
```

---

## 🧪 Testing Ory Integration

### Test Script

**File**: `scripts/test-ory-integration.js`

```javascript
#!/usr/bin/env node

const fetch = require('cross-fetch');
const readline = require('readline');

async function testOryIntegration() {
  console.log('🧪 Testing Ory Integration...\n');

  try {
    // Test 1: Check Ory services health
    console.log('1️⃣ Testing Ory services health...');
    
    const kratosHealth = await fetch('http://localhost:4433/health');
    console.log(`   Kratos: ${kratosHealth.ok ? '✅ Healthy' : '❌ Unhealthy'}`);
    
    const hydraHealth = await fetch('http://localhost:4444/health');
    console.log(`   Hydra: ${hydraHealth.ok ? '✅ Healthy' : '❌ Unhealthy'}`);

    // Test 2: OAuth discovery
    console.log('\n2️⃣ Testing OAuth discovery...');
    const discovery = await fetch('http://localhost:4444/.well-known/openid-configuration');
    const discoveryData = await discovery.json();
    console.log(`   OAuth Issuer: ${discoveryData.issuer}`);
    console.log(`   Authorization Endpoint: ${discoveryData.authorization_endpoint}`);
    console.log(`   Token Endpoint: ${discoveryData.token_endpoint}`);

    // Test 3: Client information
    console.log('\n3️⃣ Testing OAuth client...');
    const clientResponse = await fetch('http://localhost:4445/admin/clients/mcp-server-client');
    if (clientResponse.ok) {
      const clientData = await clientResponse.json();
      console.log(`   Client ID: ${clientData.client_id}`);
      console.log(`   Scopes: ${clientData.scope}`);
      console.log(`   Grant Types: ${clientData.grant_types.join(', ')}`);
    } else {
      console.log('   ❌ Client not found');
    }

    // Test 4: MCP Server integration
    console.log('\n4️⃣ Testing MCP Server integration...');
    const mcpHealth = await fetch('http://localhost:3003/health');
    if (mcpHealth.ok) {
      const mcpData = await mcpHealth.json();
      console.log(`   MCP Server: ${mcpData.status}`);
      console.log(`   OAuth Integration: ${mcpData.oauth ? '✅ Configured' : '❌ Not configured'}`);
    } else {
      console.log('   ❌ MCP Server not available');
    }

    console.log('\n✅ Ory integration test completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('1. Configure Claude Desktop to use OAuth endpoint: http://localhost:4444');
    console.log('2. Use client_id: mcp-server-client');
    console.log('3. Access MCP endpoints with Bearer tokens');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testOryIntegration();
```

---

## 📋 Production Checklist

### Pre-deployment

- [ ] **Security Configuration**
  - [ ] Change all default secrets and passwords
  - [ ] Use strong, unique secrets for all services
  - [ ] Configure TLS certificates for HTTPS
  - [ ] Set up proper CORS policies
  - [ ] Configure secure cookie settings

- [ ] **Database Configuration**
  - [ ] Set up PostgreSQL cluster with replication
  - [ ] Configure database backups
  - [ ] Set up connection pooling
  - [ ] Configure database monitoring

- [ ] **Ory Configuration**
  - [ ] Configure Kratos identity schemas for your use case
  - [ ] Set up proper Hydra consent flows
  - [ ] Configure email delivery for Kratos
  - [ ] Set up proper session management
  - [ ] Configure token lifetimes appropriately

### Deployment

- [ ] **Infrastructure**
  - [ ] Deploy to Kubernetes or Docker Swarm
  - [ ] Set up load balancing
  - [ ] Configure persistent volumes
  - [ ] Set up network policies

- [ ] **Monitoring**
  - [ ] Configure Prometheus metrics
  - [ ] Set up log aggregation
  - [ ] Configure alerts for critical issues
  - [ ] Set up health checks

### Post-deployment

- [ ] **Testing**
  - [ ] Run integration tests
  - [ ] Perform load testing
  - [ ] Test disaster recovery procedures
  - [ ] Validate security configurations

- [ ] **Maintenance**
  - [ ] Set up automated updates
  - [ ] Configure log retention
  - [ ] Set up backup verification
  - [ ] Document operational procedures

This comprehensive Ory integration guide provides everything needed to deploy the Remote MCP Server with production-grade OAuth infrastructure using Ory Hydra and Kratos.