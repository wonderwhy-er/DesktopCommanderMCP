# Desktop Commander Cursor Plugin

Desktop Commander gives Cursor agents access to a local MCP server for terminal sessions, filesystem work, structured documents, search, process management, and SSH workflows — plus skills and a rule that steer the agent toward those capabilities.

## Components

- MCP server: `desktop-commander`, installed with `npx -y @wonderwhy-er/desktop-commander@latest`.
- Rule: `rules/desktop-commander-default.mdc` — always-on guidance for when to prefer Desktop Commander's tools.
- Skill: `desktop-commander-overview` — explains when to use Desktop Commander MCP tools and how common workflows compose.
- Skill: `terminal` — persistent shells/REPLs, SSH, Windows PowerShell, process/port inspection, and saving recurring workflows as scripts.
- Skill: `computer-health-check` — read-only system health check (CPU, memory, disk, battery, startup) with safe, opt-in cleanups.
- Skill: `ai-tools-setup` — install, configure, and repair Claude Desktop, MCP servers, and local AI tooling (mcp.json / claude_desktop_config.json).
- Skill: `knowledge-base` — build and maintain a Markdown knowledge base any AI agent can navigate without a vector database.
- Skill: `obsidian-vault` — organize Obsidian vaults: MOCs, wikilinks, properties, Dataview/Bases dashboards, and orphan/link cleanup.

## Usage

Install the plugin in Cursor, then ask the agent to use Desktop Commander when it needs persistent shells, long-running processes, local files outside the workspace, Excel/DOCX/PDF handling, large CSV analysis, remote SSH sessions, a system health check, AI-tooling setup, or knowledge-base/Obsidian organization.

For full project documentation, see the repository README.
