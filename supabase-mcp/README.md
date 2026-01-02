# Desktop Commander Remote Server

A comprehensive Model Context Protocol (MCP) server that enables **remote agent execution** through Supabase real-time infrastructure. This system allows Claude Desktop to execute tools on remote machines via authenticated agents, providing a distributed computing platform for AI workflows.

## 🌟 Key Features

- **Remote Tool Execution**: Run MCP tools on distributed agents across different machines
- **Real-time Communication**: Supabase channels for instant tool call coordination
- **OAuth 2.0 Security**: Secure authentication with PKCE for both server and agents
- **Agent Management**: Automatic registration, presence tracking, and heartbeat monitoring
- **Database Persistence**: Full audit trail of tool calls and agent activity
- **Multi-Environment Support**: Works on macOS, Windows, and Linux (desktop + headless)
- **Extensible Architecture**: Easy to add new tools and capabilities via the MCP SDK

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

The database schema is defined in `migrations/`. You need to apply these to your Supabase project.

```bash
# Example: Apply using Supabase CLI or copy-paste content into SQL Editor
# See migrations/001_remote_mcp_schema.sql
```

### 3. Start the Server

```bash
# Development mode
npm run dev

# Production mode
npm start
```

The server will be available at `http://localhost:3007`.

### 4. Connect an Agent

In a separate terminal or machine:

```bash
# Start an agent
npm run agent

# Follow the authentication prompts
```

### 5. Test with Claude Desktop

Configure Claude Desktop to connect to the MCP server.

**Note:** The HTTP connector script is currently being refactored. You may need to use a custom transport or connect directly if supported.

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
         │                       │      Job Token        │
         │                       ├──────────────────────►│
         │                       │                       │
         │                       │   3. Tool Result      │
         │                       │◄──────────────────────┤
         │   4. MCP Response     │                       │
         │◄──────────────────────┤                       │
```

### Key Components

1.  **Desktop Commander Remote Server**: Handles Claude Desktop connections and OAuth authentication.
2.  **Remote MCP Manager**: Integrates with the MCP SDK and manages transports.
3.  **Tool Call Processor**: Routes tool calls to available agents via Supabase Realtime and handles responses.
4.  **Remote Agent**: Executes tools on remote machines and reports back.

## 🔧 Available Tools

### Generic Tools

-   `list_agents`: List connected agents for the current user.

### Remote Tools

Agents can execute tools defined in the server's tool configuration:
-   `remote_echo`: Test remote agent connectivity.
-   `agent_status`: View connected agents and their status.
-   Additional tools can be added via `src/server/remote-mcp/clientTools/client-tools.js`.

## 🛡️ Security Model

### Authentication Flow

1.  **Agent Authentication**: OAuth 2.0 with PKCE for secure agent registration.
2.  **User Scoping**: All tool calls are scoped to authenticated users.
3.  **Channel Isolation**: Real-time channels are user-specific.
4.  **Database Security**: Row Level Security (RLS) policies enforce user isolation.

### Key Security Features

-   No shared state between users
-   Encrypted communication through Supabase
-   Automatic agent timeout and cleanup
-   Audit trail for all tool executions

## 📚 Documentation

Detailed documentation is available in the following files:

-   [**INSTALLATION.md**](./INSTALLATION.md) - Comprehensive setup and configuration guide
-   [**ARCHITECTURE.md**](./ARCHITECTURE.md) - System design and technical details
-   [**API.md**](./API.md) - API endpoints and tool specifications

## 🔄 Workflows

### Basic Remote Tool Execution

1.  **Agent Connection**: Agent authenticates and registers with server.
2.  **Tool Request**: Claude Desktop sends MCP tool request to server.
3.  **Dispatch**: Server creates a tool call record; Supabase broadcasts it to the user's agent.
4.  **Execution**: Agent receives the job, executes the tool, and updates the record with the result.
5.  **Response**: Server observes the completion and forwards the result to Claude Desktop.

### Agent Management

-   **Registration**: Automatic agent registration with capabilities reporting.
-   **Presence Tracking**: Real-time status updates and heartbeat monitoring.
-   **Cleanup**: Automatic removal of offline or stale agents.

## 🚦 Status Indicators

### Server Health

-   🟢 **Healthy**: All services operational
-   🟡 **Degraded**: Some components experiencing issues
-   🔴 **Down**: Server unavailable

### Agent Status

-   🟢 **Online**: Agent active and ready to execute tools
-   🟡 **Connecting**: Agent in process of connecting
-   🔴 **Offline**: Agent disconnected or unreachable

## 🤝 Contributing

1.  Fork the repository
2.  Create a feature branch (`git checkout -b feature/amazing-feature`)
3.  Commit your changes (`git commit -m 'Add amazing feature'`)
4.  Push to the branch (`git push origin feature/amazing-feature`)
5.  Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

-   **Issues**: Report bugs and request features via GitHub Issues
-   **Documentation**: Check the detailed guides in the `/docs` folder
-   **Community**: Join our Discord for real-time support

## 🔗 Related Projects

-   [Model Context Protocol](https://github.com/anthropics/mcp) - Official MCP specification
-   [Claude Desktop](https://claude.ai/desktop) - Claude's desktop application

---

**Built with ❤️ for the MCP ecosystem**