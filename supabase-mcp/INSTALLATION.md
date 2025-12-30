# Installation Guide

This comprehensive guide will walk you through setting up the Supabase MCP Server with remote agent capabilities from scratch.

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18+** - [Download from nodejs.org](https://nodejs.org/)
- **npm or yarn** - Comes with Node.js
- **Supabase account** - [Sign up at supabase.com](https://supabase.com/)
- **Claude Desktop** - [Download Claude Desktop](https://claude.ai/desktop)
- **Git** - For cloning the repository

## 🚀 Quick Installation (5 minutes)

### 1. Clone and Setup

```bash
# Clone the repository
git clone <repository-url>
cd supabase-mcp

# Install dependencies
npm install

# Create environment configuration
cp .env.example .env
```

### 2. Configure Supabase

Edit `.env` with your Supabase project details:

```bash
nano .env  # or use your preferred editor
```

### 3. Database Setup

```bash
# Run the database migration
npm run setup
```

### 4. Start the System

```bash
# Terminal 1: Start the server
npm start

# Terminal 2: Start an agent (optional)
npm run agent
```

🎉 **Done!** The system is now running at `http://localhost:3007`

---

## 📋 Detailed Installation

### Step 1: Environment Setup

#### 1.1 Install Node.js

**macOS (using Homebrew):**
```bash
brew install node@18
```

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows:**
- Download from [nodejs.org](https://nodejs.org/)
- Run the installer and follow the prompts

#### 1.2 Verify Installation

```bash
node --version  # Should show v18.x.x or higher
npm --version   # Should show a version number
```

### Step 2: Supabase Project Setup

#### 2.1 Create a Supabase Project

1. Go to [supabase.com](https://supabase.com/) and sign in
2. Click "New Project"
3. Choose your organization
4. Enter project name (e.g., "mcp-remote-agents")
5. Create a strong database password
6. Select a region close to your location
7. Click "Create new project"

#### 2.2 Get Project Credentials

Once your project is created:

1. Go to **Settings** → **API**
2. Copy the following values:
   - **Project URL** (looks like `https://xyz.supabase.co`)
   - **Publishable API Key** (starts with `sb_publishable_`)
   - **Secret API Key** (starts with `sb_secret_`)

### Step 3: Project Configuration

#### 3.1 Environment Variables

Create and edit `.env` file:

```bash
cp .env.example .env
nano .env
```

Add your Supabase credentials:

```env
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_publishable_key_here
SUPABASE_SECRET_KEY=your_secret_key_here

# Server Configuration
MCP_SERVER_PORT=3007
MCP_SERVER_HOST=localhost
NODE_ENV=development
DEBUG_MODE=true

# Optional: CORS Configuration
CORS_ORIGINS=["http://localhost:3007"]
```

#### 3.2 Install Dependencies

```bash
# Install all required packages
npm install

# Verify installation
npm list --depth=0
```

### Step 4: Database Setup

#### 4.1 Apply Database Schema

Run the setup script to create required tables:

```bash
npm run setup
```

This creates the following tables:
- `mcp_pkce_codes` - OAuth PKCE codes storage
- `mcp_agents` - Agent registry and status
- `mcp_remote_calls` - Tool call tracking

#### 4.2 Verify Database Setup

Check that tables were created successfully:

1. Go to Supabase Dashboard → **Table Editor**
2. Verify the three tables exist
3. Check that Row Level Security (RLS) is enabled

### Step 5: Start the Server

#### 5.1 Development Mode

Start the server in development mode with detailed logging:

```bash
npm run dev
```

You should see:
```
🚀 Supabase MCP Server started
Server: http://localhost:3007
Health: http://localhost:3007/health
MCP: http://localhost:3007/mcp
Environment: development
```

#### 5.2 Production Mode

For production deployment:

```bash
NODE_ENV=production npm start
```

#### 5.3 Verify Server Health

Test the server is running correctly:

```bash
curl http://localhost:3007/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "supabase-mcp-server",
  "version": "1.0.0",
  "uptime": { ... },
  "environment": { ... }
}
```

### Step 6: Agent Setup (Optional)

#### 6.1 Start an Agent

In a separate terminal or on another machine:

```bash
# Local agent
npm run agent

# Remote agent (specify server URL)
BASE_MCP_URL=https://your-server.com npm run agent
```

#### 6.2 Agent Authentication

The agent will guide you through authentication:

**Desktop Mode (automatic):**
1. Browser opens automatically
2. Sign in with your Supabase account
3. Agent connects automatically

**Headless Mode (manual):**
1. Copy the provided URL
2. Open in a browser
3. Sign in and copy the access token
4. Paste token in the agent terminal

#### 6.3 Verify Agent Connection

Check agent status via the server API:

```bash
# Get agent status (requires authentication)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     http://localhost:3007/tools/agent_status
```

### Step 7: Claude Desktop Integration

#### 7.1 Configure Claude Desktop

Add the MCP server to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "supabase-mcp": {
      "command": "node",
      "args": [
        "/path/to/supabase-mcp/src/client/http-connector.js"
      ],
      "env": {
        "MCP_SERVER_URL": "http://localhost:3007"
      }
    }
  }
}
```

#### 7.2 Test MCP Integration

1. Restart Claude Desktop
2. Open a new conversation
3. The MCP server should appear in the available tools
4. Try using `remote_echo` or `agent_status` tools

## 🔧 Configuration Options

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | - | **Required** - Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | - | **Required** - Publishable API key |
| `SUPABASE_SECRET_KEY` | - | **Required** - Secret API key |
| `MCP_SERVER_PORT` | `3007` | Port for the MCP server |
| `MCP_SERVER_HOST` | `localhost` | Host for the MCP server |
| `NODE_ENV` | `development` | Environment mode |
| `DEBUG_MODE` | `false` | Enable debug logging |
| `CORS_ORIGINS` | `[]` | Allowed CORS origins (JSON array) |

### Server Configuration

#### Custom Port Configuration

To run on a different port:

```bash
MCP_SERVER_PORT=8080 npm start
```

#### HTTPS Configuration

For production with HTTPS:

```bash
# Enable HTTPS (requires certificates)
ENABLE_HTTPS=true npm start
```

#### CORS Configuration

For cross-origin requests:

```bash
# Allow specific origins
CORS_ORIGINS='["https://myapp.com", "https://localhost:3000"]' npm start
```

### Agent Configuration

#### Remote Agent Setup

To connect an agent from a different machine:

```bash
# On the remote machine
BASE_MCP_URL=https://your-server.com npm run agent
```

#### Agent Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_MCP_URL` | `http://localhost:3007` | MCP server URL |

## 🧪 Testing Your Installation

### 1. Health Check Test

```bash
npm run test-health
```

### 2. Authentication Test

```bash
npm run test-auth
```

### 3. Complete Integration Test

```bash
npm run test
```

### 4. Agent Integration Test

```bash
node test-agent.js
```

## 🚨 Troubleshooting

### Common Issues

#### Server Won't Start

**Error:** `Port 3007 is already in use`
```bash
# Find process using the port
lsof -i :3007

# Kill the process or use a different port
MCP_SERVER_PORT=8080 npm start
```

**Error:** `Supabase connection failed`
- Verify your Supabase URL and API keys in `.env`
- Check that your Supabase project is running
- Ensure network connectivity to Supabase

#### Agent Connection Issues

**Error:** `No agents available`
- Start an agent with `npm run agent`
- Check agent authentication completed successfully
- Verify agent appears in `agent_status` tool

**Error:** `Authentication failed`
- Clear browser cookies for the auth domain
- Check Supabase Auth settings
- Verify API keys are correct

#### Claude Desktop Integration

**Error:** `MCP server not found`
- Verify the path to `http-connector.js` is correct
- Check that the server is running on the specified URL
- Restart Claude Desktop after configuration changes

### Debug Mode

Enable detailed logging:

```bash
DEBUG_MODE=true npm start
```

### Log Files

Check log files for detailed error information:
- Server logs: Console output
- Agent logs: Console output
- Database logs: Supabase Dashboard → Logs

### Support Resources

1. **Documentation**: Check other `.md` files in this repository
2. **Issues**: Report problems on GitHub Issues
3. **Logs**: Include relevant log output when reporting issues
4. **Configuration**: Double-check all environment variables

## 🎯 Next Steps

After successful installation:

1. **Explore Tools**: Try the available MCP tools in Claude Desktop
2. **Add Custom Tools**: Extend the agent with your own tools
3. **Scale Agents**: Deploy agents on multiple machines
4. **Monitor Usage**: Check the health and stats endpoints
5. **Production Deploy**: See [DEPLOYMENT.md](./DEPLOYMENT.md) for production setup

## 📚 Additional Resources

- [Architecture Guide](./ARCHITECTURE.md) - Understand the system design
- [API Reference](./API.md) - Complete API documentation
- [Deployment Guide](./DEPLOYMENT.md) - Production deployment
- [Supabase Documentation](https://supabase.com/docs) - Supabase features
- [MCP Specification](https://github.com/anthropics/mcp) - MCP protocol details