# Supabase MCP Server

A comprehensive Model Context Protocol (MCP) server that enables **remote agent execution** through Supabase real-time infrastructure. This system allows Claude Desktop to execute tools on remote machines via authenticated agents, providing a distributed computing platform for AI workflows.

## 🌟 Key Features

- **Remote Tool Execution**: Run MCP tools on distributed agents across different machines
- **Real-time Communication**: Supabase channels for instant tool call coordination
- **OAuth 2.0 Security**: Secure authentication with PKCE for both server and agents
- **Agent Management**: Automatic registration, presence tracking, and heartbeat monitoring
- **Database Persistence**: Full audit trail of tool calls and agent activity
- **Multi-Environment Support**: Works on macOS, Windows, and Linux (desktop + headless)
- **Extensible Architecture**: Easy to add new tools and capabilities

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Supabase account and project
- Claude Desktop (for testing MCP integration)

### 1. Installation

```bash
# Clone the repository
git clone <repository-url>
cd supabase-mcp

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your Supabase configuration
```

### 2. Database Setup

```bash
# Apply database migrations
npm run db:migrate

# Verify setup
npm run test
```

### 3. Start the Server

```bash
# Development mode
npm run dev

# Production mode
npm start
```

The server will be available at `http://localhost:3007`

### 4. Connect an Agent

In a separate terminal or machine:

```bash
# Start an agent
npm run agent

# Follow the authentication prompts
```

### 5. Test with Claude Desktop

Configure Claude Desktop with the MCP server endpoint and test remote tool execution.

## 📋 Core Concepts

### Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Claude        │    │  Supabase MCP   │    │  Remote Agent   │
│   Desktop       │    │  Server         │    │  (Your Machine) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │   1. MCP Request      │                       │
         ├──────────────────────►│                       │
         │                       │   2. Real-time        │
         │                       │      Broadcast        │
         │                       ├──────────────────────►│
         │                       │                       │
         │                       │   3. Tool Result      │
         │                       │◄──────────────────────┤
         │   4. MCP Response     │                       │
         │◄──────────────────────┤                       │
```

### Key Components

1. **Base MCP Server**: Handles Claude Desktop connections and OAuth authentication
2. **Channel Manager**: Manages Supabase real-time channels for communication
3. **Tool Dispatcher**: Routes tool calls to available agents and handles responses
4. **Agent Registry**: Tracks connected agents and their capabilities
5. **Remote Agent**: Executes tools on remote machines and reports back

## 🔧 Available Tools

### Server Tools

- `remote_echo`: Test remote agent connectivity
- `agent_status`: View connected agents and their status
- `supabase_query`: Execute database queries (authenticated users)
- `user_info`: Get current user information

### Agent Tools

Agents can execute any tool supported by their environment:

- Basic tools: `echo`, file operations
- Desktop Commander MCP tools (when integrated)
- Custom tools defined in agent capabilities

## 🛡️ Security Model

### Authentication Flow

1. **Agent Authentication**: OAuth 2.0 with PKCE for secure agent registration
2. **User Scoping**: All tool calls are scoped to authenticated users
3. **Channel Isolation**: Real-time channels are user-specific
4. **Database Security**: Row Level Security (RLS) policies enforce user isolation

### Key Security Features

- No shared state between users
- Encrypted communication through Supabase
- Automatic agent timeout and cleanup
- Audit trail for all tool executions

## 📚 Documentation

Detailed documentation is available in the following files:

- [**INSTALLATION.md**](./INSTALLATION.md) - Comprehensive setup and configuration guide
- [**ARCHITECTURE.md**](./ARCHITECTURE.md) - System design and technical details
- [**API.md**](./API.md) - API endpoints and tool specifications
- [**DEPLOYMENT.md**](./DEPLOYMENT.md) - Production deployment guide

## 🔄 Workflows

### Basic Remote Tool Execution

1. **Agent Connection**: Agent authenticates and registers with server
2. **Tool Request**: Claude Desktop sends MCP tool request to server
3. **Dispatch**: Server broadcasts tool call to user's agent via Supabase channel
4. **Execution**: Agent receives call, executes tool, and sends result back
5. **Response**: Server forwards result to Claude Desktop

### Agent Management

- **Registration**: Automatic agent registration with capabilities reporting
- **Presence Tracking**: Real-time status updates and heartbeat monitoring
- **Cleanup**: Automatic removal of offline or stale agents

## 🚦 Status Indicators

### Server Health

- 🟢 **Healthy**: All services operational
- 🟡 **Degraded**: Some components experiencing issues
- 🔴 **Down**: Server unavailable

### Agent Status

- 🟢 **Online**: Agent active and ready to execute tools
- 🟡 **Connecting**: Agent in process of connecting
- 🔴 **Offline**: Agent disconnected or unreachable

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Issues**: Report bugs and request features via GitHub Issues
- **Documentation**: Check the detailed guides in the `/docs` folder
- **Community**: Join our Discord for real-time support

## 🔗 Related Projects

- [Model Context Protocol](https://github.com/anthropics/mcp) - Official MCP specification
- [Claude Desktop](https://claude.ai/desktop) - Claude's desktop application
- [Supabase](https://supabase.com) - Open source Firebase alternative

---

**Built with ❤️ for the MCP ecosystem**