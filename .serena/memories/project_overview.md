# Desktop Commander MCP - Project Overview

## Purpose
Desktop Commander is a Model Context Protocol (MCP) server that extends Claude Desktop with comprehensive terminal and file system capabilities. It allows Claude to execute shell commands, manage processes, perform file operations, and edit code directly on the user's system.

## Tech Stack
- **Language**: TypeScript
- **Runtime**: Node.js (>=18.0.0)
- **Framework**: MCP SDK (@modelcontextprotocol/sdk)
- **Build System**: TypeScript compiler with custom scripts
- **Key Dependencies**:
  - MCP SDK for protocol handling
  - @vscode/ripgrep for file searching
  - fastest-levenshtein for fuzzy matching
  - zod for schema validation

## Project Structure
- `src/`: Main source code
  - `tools/`: Tool implementations (filesystem, terminal, config, etc.)
  - `handlers/`: Request handlers for different operations
  - `utils/`: Utility functions and helpers
  - `server.ts`: Main MCP server setup
  - `index.ts`: Entry point
- `test/`: Test files and examples
- `scripts/`: Build and utility scripts
- `dist/`: Compiled JavaScript output

## Key Features
- Terminal command execution with process management
- Full filesystem operations (read, write, search)
- Code editing with surgical text replacements
- Configuration management
- Audit logging
- Usage analytics
- Docker support for isolated execution

## Version: 0.2.11
