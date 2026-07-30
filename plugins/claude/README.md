# Desktop Commander Claude Code Plugin

Desktop Commander gives Claude Code access to a local MCP server for terminal sessions, filesystem work, structured documents, search, process management, and SSH workflows — plus a set of skills that steer the agent toward those capabilities for common tasks.

## Components

- MCP server: `desktop-commander`, installed with `npx -y @wonderwhy-er/desktop-commander@latest`.
- Skill: `desktop-commander-overview` — explains when to use Desktop Commander MCP tools and how common workflows compose.
- Skill: `terminal` — persistent shells/REPLs, SSH, Windows PowerShell, process/port inspection, and saving recurring workflows as scripts.
- Skill: `computer-health-check` — read-only system health check (CPU, memory, disk, battery, startup) with safe, opt-in cleanups.
- Skill: `ai-tools-setup` — install, configure, and repair Claude Desktop, MCP servers, and local AI tooling (mcp.json / claude_desktop_config.json).
- Skill: `knowledge-base` — build and maintain a Markdown knowledge base any AI agent can navigate without a vector database.
- Skill: `obsidian-vault` — organize Obsidian vaults: MOCs, wikilinks, properties, Dataview/Bases dashboards, and orphan/link cleanup.

## Usage

Install the plugin in Claude Code, then ask Claude to use Desktop Commander when it needs persistent shells, long-running processes, local file reads, Excel/DOCX/PDF handling, large CSV analysis, remote SSH sessions, a system health check, AI-tooling setup, or knowledge-base/Obsidian organization.

For full project documentation, see the repository README.
