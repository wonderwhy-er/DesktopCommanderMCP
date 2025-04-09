# Desktop Commander MCP
### Search, update, manage files and run terminal commands with AI

[![npm downloads](https://img.shields.io/npm/dw/@wonderwhy-er/desktop-commander)](https://www.npmjs.com/package/@wonderwhy-er/desktop-commander)
[![smithery badge](https://smithery.ai/badge/@wonderwhy-er/desktop-commander)](https://smithery.ai/server/@wonderwhy-er/desktop-commander)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow.svg)](https://www.buymeacoffee.com/wonderwhyer)


[![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/kQ27sNnZr7)

[![Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=948854&theme=light)](https://www.producthunt.com/posts/desktop-commander-mcp)

Short version. Four key things. Terminal commands, diff based file editing, ripgrep based text search in folders, ability to read files from urls 


![Desktop Commander MCP](https://raw.githubusercontent.com/wonderwhy-er/ClaudeComputerCommander/main/header.png)
<a href="https://glama.ai/mcp/servers/zempur9oh4">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/zempur9oh4/badge" alt="Claude Desktop Commander MCP server" />
</a>

## Table of Contents
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Handling Long-Running Commands](#handling-long-running-commands)
- [Work in Progress and TODOs](#work-in-progress-and-todos)
- [Media links](#media)
- [Testimonials](#testimonials)
- [Frequently Asked Questions](#frequently-asked-questions)
- [Contributing](#contributing)
- [License](#license)

This is server that allows Claude desktop app to execute long-running terminal commands on your computer and manage processes through Model Context Protocol (MCP) + Built on top of [MCP Filesystem Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) to provide additional search and replace file editing capabilities .

## Features

- Execute terminal commands with output streaming
- Command timeout and background execution support
- Process management (list and kill processes)
- Session management for long-running commands
- Server configuration management:
  - Get/set configuration values
  - Update multiple settings at once
  - Dynamic configuration changes without server restart
- Full filesystem operations:
  - Read/write files
  - Create/list directories
  - Move files/directories
  - Search files
  - Get file metadata
  - Code editing capabilities:
  - Surgical text replacements for small changes
  - Full file rewrites for major changes
  - Multiple file support
  - Pattern-based replacements
  - vscode-ripgrep based recursive code or text search in folders

## Installation
First, ensure you've downloaded and installed the [Claude Desktop app](https://claude.ai/download) and you have [npm installed](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).

### Option 1: Install through npx
Just run this in terminal
```
npx @wonderwhy-er/desktop-commander@latest setup
```

For debugging mode (allows Node.js inspector connection):
```
npx @wonderwhy-er/desktop-commander@latest setup --debug
```
Restart Claude if running

### Option 2: Using bash script installer (macOS)
For macOS users, you can use our automated bash installer which will check your Node.js version, install it if needed, and automatically configure Desktop Commander:
```
curl -fsSL https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/install.sh | bash
```
This script handles all dependencies and configuration automatically for a seamless setup experience.

### Option 3: Installing via Smithery

To install Desktop Commander for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@wonderwhy-er/desktop-commander):

```bash
npx -y @smithery/cli install @wonderwhy-er/desktop-commander --client claude
```

### Option 4: Add to claude_desktop_config by hand
Add this entry to your claude_desktop_config.json:

- On Mac: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
- On Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- On Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "npx",
      "args": [
        "-y",
        "@wonderwhy-er/desktop-commander"
      ]
    }
  }
}
```
Restart Claude if running

### Option 5: Checkout locally
1. Clone and build:
```bash
git clone https://github.com/wonderwhy-er/ClaudeComputerCommander.git
cd ClaudeComputerCommander
npm run setup
```
Restart Claude if running

The setup command will:
- Install dependencies
- Build the server
- Configure Claude's desktop app
- Add MCP servers to Claude's config if needed

### Updating Desktop Commander

When installed through npx (Option 1) or Smithery (Option 2), Desktop Commander will automatically update to the latest version whenever you restart Claude. No manual update process is needed.

For manual installations, you can update by running the setup command again.

## Usage

The server provides these tool categories:

### Configuration Tools
- `get_config`: Get the complete server configuration
- `get_config_value`: Get a specific configuration value
- `set_config_value`: Set a specific configuration value
- `update_config`: Update multiple configuration values at once

### Terminal Tools
- `execute_command`: Run commands with configurable timeout and shell selection
- `read_output`: Get output from long-running commands
- `force_terminate`: Stop running command sessions
- `list_sessions`: View active command sessions
- `list_processes`: View system processes
- `kill_process`: Terminate processes by PID
- `block_command`/`unblock_command`: Manage command blacklist

### Filesystem Tools
- `read_file`/`write_file`: Read files from local filesystem or URLs (supports viewing PNG, JPEG, GIF, and WebP images directly in Claude)
- `create_directory`/`list_directory`: Directory management  
- `move_file`: Move/rename files
- `search_files`: Pattern-based file search
- `get_file_info`: File metadata
- `search_code`: Recursive ripgrep based text and code search

### Edit Tools
- `edit_block`: Apply surgical text replacements (best for changes <20% of file size)
- `write_file`: Complete file rewrites (best for large changes >20% or when edit_block fails)

Search/Replace Block Format:
```
filepath.ext
<<<<<<< SEARCH
content to find
=======
new content
>>>>>>> REPLACE
```

Example:
```
src/main.js
<<<<<<< SEARCH
console.log("old message");
=======
console.log("new message");
>>>>>>> REPLACE
```

### URL Support
- `read_file` can now fetch content from both local files and URLs
- Example: `read_file` with `isUrl: true` parameter to read from web resources
- Handles both text and image content from remote sources
- Images (local or from URLs) are displayed visually in Claude's interface, not as text
- Claude can see and analyze the actual image content
- Default 30-second timeout for URL requests

## Handling Long-Running Commands

For commands that may take a while:

## Configuration Management

You can manage server configuration using the provided tools:

```javascript
// Get the entire config
get_config({})

// Get a specific config value
get_config_value({ "key": "defaultShell" })

// Set a specific config value
set_config_value({ "key": "defaultShell", "value": "/bin/zsh" })

// Update multiple config values at once
update_config({
  "config": {
    "defaultShell": "/bin/bash",
    "logLevel": "debug",
    "allowedDirectories": ["/Users/username/projects"]
  }
})
```

The configuration is saved to `config.json` in the server's working directory and persists between server restarts.

## Using Different Shells

You can specify which shell to use for command execution:

```javascript
// Using default shell (bash or system default)
execute_command({ "command": "echo $SHELL" })

// Using zsh specifically
execute_command({ "command": "echo $SHELL", "shell": "/bin/zsh" })

// Using bash specifically
execute_command({ "command": "echo $SHELL", "shell": "/bin/bash" })
```

This allows you to use shell-specific features or maintain consistent environments across commands.

1. `execute_command` returns after timeout with initial output
2. Command continues in background
3. Use `read_output` with PID to get new output
4. Use `force_terminate` to stop if needed

## Debugging

If you need to debug the server, you can install it in debug mode:

```bash
# Using npx
npx @wonderwhy-er/desktop-commander@latest setup --debug

# Or if installed locally
npm run setup:debug
```

This will:
1. Configure Claude to use a separate "desktop-commander" server
2. Enable Node.js inspector protocol with `--inspect-brk=9229` flag
3. Pause execution at the start until a debugger connects
4. Enable additional debugging environment variables

To connect a debugger:
- In Chrome, visit `chrome://inspect` and look for the Node.js instance
- In VS Code, use the "Attach to Node Process" debug configuration
- Other IDEs/tools may have similar "attach" options for Node.js debugging

Important debugging notes:
- The server will pause on startup until a debugger connects (due to the `--inspect-brk` flag)
- If you don't see activity during debugging, ensure you're connected to the correct Node.js process
- Multiple Node processes may be running; connect to the one on port 9229
- The debug server is identified as "desktop-commander-debug" in Claude's MCP server list

Troubleshooting:
- If Claude times out while trying to use the debug server, your debugger might not be properly connected
- When properly connected, the process will continue execution after hitting the first breakpoint
- You can add additional breakpoints in your IDE once connected

## Model Context Protocol Integration

This project extends the MCP Filesystem Server to enable:
- Local server support in Claude Desktop
- Full system command execution
- Process management
- File operations
- Code editing with search/replace blocks

Created as part of exploring Claude MCPs: https://youtube.com/live/TlbjFDbl5Us

## DONE
- **07-04-2025 Added URL support** - `read_file` command can now fetch content from URLs
- **28-03-2025 Fixed "Watching /" JSON error** - Implemented custom stdio transport to handle non-JSON messages and prevent server crashes
- **25-03-2025 Better code search** ([merged](https://github.com/wonderwhy-er/ClaudeDesktopCommander/pull/17)) - Enhanced code exploration with context-aware results

## Work in Progress and TODOs

The following features are currently being developed or planned:

- **Better configurations** ([in progress](https://github.com/wonderwhy-er/ClaudeDesktopCommander/pull/16)) - Improved settings for allowed paths, commands and shell environment
- **Windows environment fixes** ([in progress](https://github.com/wonderwhy-er/ClaudeDesktopCommander/pull/13)) - Resolving issues specific to Windows platforms
- **Linux improvements** ([in progress](https://github.com/wonderwhy-er/ClaudeDesktopCommander/pull/12)) - Enhancing compatibility with various Linux distributions
- **Support for WSL** - Windows Subsystem for Linux integration
- **Support for SSH** - Remote server command execution
- **Installation troubleshooting guide** - Comprehensive help for setup issues

## Website

Visit our official website at [https://desktopcommander.app/](https://desktopcommander.app/) for the latest information, documentation, and updates.

## Media
Learn more about this project through these resources:

### Article
[Claude with MCPs replaced Cursor & Windsurf. How did that happen?](https://wonderwhy-er.medium.com/claude-with-mcps-replaced-cursor-windsurf-how-did-that-happen-c1d1e2795e96) - A detailed exploration of how Claude with Model Context Protocol capabilities is changing developer workflows.

### Video
[Claude Desktop Commander Video Tutorial](https://www.youtube.com/watch?v=ly3bed99Dy8) - Watch how to set up and use the Commander effectively.

### Publication at AnalyticsIndiaMag
[![analyticsindiamag.png](testemonials%2Fanalyticsindiamag.png)
This Developer Ditched Windsurf, Cursor Using Claude with MCPs](https://analyticsindiamag.com/ai-features/this-developer-ditched-windsurf-cursor-using-claude-with-mcps/)

### Community
Join our [Discord server](https://discord.gg/kQ27sNnZr7) to get help, share feedback, and connect with other users.

## Testimonials

[![It's a life saver! I paid Claude + Cursor currently which I always feel it's kind of duplicated. This solves the problem ultimately. I am so happy. Thanks so much. Plus today Claude has added the web search support. With this MCP + Internet search, it writes the code with the latest updates. It's so good when Cursor doesn't work sometimes or all the fast requests are used.](https://raw.githubusercontent.com/wonderwhy-er/ClaudeComputerCommander/main/testemonials/img.png) https://www.youtube.com/watch?v=ly3bed99Dy8&lc=UgyyBt6_ShdDX_rIOad4AaABAg
](https://www.youtube.com/watch?v=ly3bed99Dy8&lc=UgyyBt6_ShdDX_rIOad4AaABAg
)

[![This is the first comment I've ever left on a youtube video, THANK YOU! I've been struggling to update an old Flutter app in Cursor from an old pre null-safety version to a current version and implemented null-safety using Claude 3.7. I got most of the way but had critical BLE errors that I spent days trying to resolve with no luck. I tried Augment Code but it didn't get it either. I implemented your MCP in Claude desktop and was able to compare the old and new codebase fully, accounting for the updates in the code, and fix the issues in a couple of hours. A word of advice to people trying this, be sure to stage changes and commit when appropriate to be able to undo unwanted changes. Amazing!](https://raw.githubusercontent.com/wonderwhy-er/ClaudeComputerCommander/main/testemonials/img_1.png)
https://www.youtube.com/watch?v=ly3bed99Dy8&lc=UgztdHvDMqTb9jiqnf54AaABAg](https://www.youtube.com/watch?v=ly3bed99Dy8&lc=UgztdHvDMqTb9jiqnf54AaABAg
)

[![Great! I just used Windsurf, bought license a week ago, for upgrading old fullstack socket project and it works many times good or ok but also many times runs away in cascade and have to revert all changes losing hundereds of cascade tokens. In just a week down to less than 100 tokens and do not want to buy only 300 tokens for 10$. This Claude MCP ,bought claude Pro finally needed but wanted very good reason to also have next to ChatGPT, and now can code as much as I want not worrying about token cost.
Also this is much more than code editing it is much more thank you for great video!](https://raw.githubusercontent.com/wonderwhy-er/ClaudeComputerCommander/main/testemonials/img_2.png)
https://www.youtube.com/watch?v=ly3bed99Dy8&lc=UgyQFTmYLJ4VBwIlmql4AaABAg](https://www.youtube.com/watch?v=ly3bed99Dy8&lc=UgyQFTmYLJ4VBwIlmql4AaABAg)

[![it is a great tool, thank you, I like using it, as it gives claude an ability to do surgical edits, making it more like a human developer.](https://raw.githubusercontent.com/wonderwhy-er/ClaudeComputerCommander/main/testemonials/img_3.png)
https://www.youtube.com/watch?v=ly3bed99Dy8&lc=Ugy4-exy166_Ma7TH-h4AaABAg](https://www.youtube.com/watch?v=ly3bed99Dy8&lc=Ugy4-exy166_Ma7TH-h4AaABAg)

[![You sir are my hero. You've pretty much summed up and described my experiences of late, much better than I could have. Cursor and Windsurf both had me frustrated to the point where I was almost yelling at my computer screen. Out of whimsy, I thought to myself why not just ask Claude directly, and haven't looked back since.
Claude first to keep my sanity in check, then if necessary, engage with other IDEs, frameworks, etc. I thought I was the only one, glad to see I'm not lol.
33
1](https://raw.githubusercontent.com/wonderwhy-er/ClaudeComputerCommander/main/testemonials/img_4.png)
https://medium.com/@pharmx/you-sir-are-my-hero-62cff5836a3e](https://medium.com/@pharmx/you-sir-are-my-hero-62cff5836a3e)

## Contributing

If you find this project useful, please consider giving it a ⭐ star on GitHub! This helps others discover the project and encourages further development.

We welcome contributions from the community! Whether you've found a bug, have a feature request, or want to contribute code, here's how you can help:

- **Found a bug?** Open an issue at [github.com/wonderwhy-er/ClaudeComputerCommander/issues](https://github.com/wonderwhy-er/ClaudeComputerCommander/issues)
- **Have a feature idea?** Submit a feature request in the issues section
- **Want to contribute code?** Fork the repository, create a branch, and submit a pull request
- **Questions or discussions?** Start a discussion in the GitHub Discussions tab

All contributions, big or small, are greatly appreciated!

If you find this tool valuable for your workflow, please consider [supporting the project](https://www.buymeacoffee.com/wonderwhyer).

## Frequently Asked Questions

Here are answers to some common questions. For a more comprehensive FAQ, see our [detailed FAQ document](FAQ.md).

### What is Claude Desktop Commander?
It's an MCP tool that enables Claude Desktop to access your file system and terminal, turning Claude into a versatile assistant for coding, automation, codebase exploration, and more.

### How is this different from Cursor/Windsurf?
Unlike IDE-focused tools, Claude Desktop Commander provides a solution-centric approach that works with your entire OS, not just within a coding environment. Claude reads files in full rather than chunking them, can work across multiple projects simultaneously, and executes changes in one go rather than requiring constant review.

### Do I need to pay for API credits?
No. This tool works with Claude Desktop's standard Pro subscription ($20/month), not with API calls, so you won't incur additional costs beyond the subscription fee.

### Does Desktop Commander automatically update?
Yes, when installed through npx or Smithery, Desktop Commander automatically updates to the latest version when you restart Claude. No manual update process is needed.

### What are the most common use cases?
- Exploring and understanding complex codebases
- Generating diagrams and documentation
- Automating tasks across your system
- Working with multiple projects simultaneously
- Making surgical code changes with precise control

### I'm having trouble installing or using the tool. Where can I get help?
Join our [Discord server](https://discord.gg/kQ27sNnZr7) for community support, check the [GitHub issues](https://github.com/wonderwhy-er/ClaudeComputerCommander/issues) for known problems, or review the [full FAQ](FAQ.md) for troubleshooting tips. You can also visit our [website FAQ section](https://desktopcommander.app#faq) for a more user-friendly experience. If you encounter a new issue, please consider [opening a GitHub issue](https://github.com/wonderwhy-er/ClaudeComputerCommander/issues/new) with details about your problem.

## Data Collection

During installation and setup, Desktop Commander collects anonymous usage data to help improve the tool. This includes:
- Operating system information
- Node.js and NPM versions
- Installation method and shell environment
- Error messages (if any occur during setup)

This data is collected using PostHog analytics and is associated with a machine-generated unique ID. No personal information is collected. This helps us understand how the tool is being used and identify common issues.

We are currently working on adding a built-in opt-out option for this data collection in an upcoming release. For now, if you wish to opt out, you can block network connections to `eu.i.posthog.com` in your firewall settings.

## License

MIT
