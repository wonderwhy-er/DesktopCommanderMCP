# Claude Desktop Commander MCP

[![npm downloads](https://img.shields.io/npm/dw/@jasondsmith72/desktop-commander)](https://www.npmjs.com/package/@jasondsmith72/desktop-commander)
[![GitHub Repo](https://img.shields.io/badge/GitHub-jasondsmith72%2FClaudeComputerCommander-blue)](https://github.com/jasondsmith72/ClaudeComputerCommander)

Enhanced version of Claude Desktop Commander with advanced monitoring, backup, and management features.

This is a server that allows Claude desktop app to execute long-running terminal commands on your computer and manage processes through Model Context Protocol (MCP) + Built on top of [MCP Filesystem Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) to provide additional search and replace file editing capabilities.

This is a fork of [wonderwhy-er/ClaudeComputerCommander](https://github.com/wonderwhy-er/ClaudeComputerCommander) with enhanced configuration options.

## Features

### Core Features
- Execute terminal commands with output streaming
- Command timeout and background execution support
- Process management (list and kill processes)
- Session management for long-running commands
- Full filesystem operations including read/write, directory creation, move files, and more
- Configurable allowed directories

### Enhanced Features
- **File History & Versioning**: Track changes to files and roll back to previous versions
- **Enhanced Backup & Restore System**: Comprehensive file backup with easy restoration
- **Enhanced Security Controls**: Granular permission levels for directories and files
- **Monitoring Dashboard**: Web interface to monitor Claude's activity on your system
- **Command Aliasing**: Create shortcuts for frequently used commands
- **Integration with MCP Servers**: Better coordination with other MCP servers
- **User-Friendly Web Interface**: Configure Claude Desktop Commander through a web browser
- **Auto-Update System**: Keep your installation up-to-date automatically
- **Cross-Platform Compatibility**: Tested across different operating systems

## Installation

First, ensure you've downloaded and installed the [Claude Desktop app](https://claude.ai/download) and you have [npm installed](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).

### Option 1: Custom Setup (Recommended)

This method is best if you don't have permissions to directly modify the Claude config file or prefer a guided approach:

1. Clone the repository:
```bash
git clone https://github.com/jasondsmith72/ClaudeComputerCommander.git
cd ClaudeComputerCommander
```

2. Install dependencies and build:
```bash
npm install
npm run build
```

3. Run the appropriate setup script based on your needs:
```bash
# For Windows with automatic configuration:
npm run setup:windows

# For guided manual setup (works on any platform):
npm run setup:custom

# For standard setup (requires write access to Claude config):
npm run setup
```

4. Follow any on-screen instructions provided by the setup script.

5. Restart Claude if it's running.

### Option 2: Add to claude_desktop_config manually

Add this entry to your claude_desktop_config.json (on Windows, found at %APPDATA%\Claude\claude_desktop_config.json):
```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "npx",
      "args": [
        "-y",
        "@jasondsmith72/desktop-commander"
      ]
    }
  }
}
```
Restart Claude if running.

## Uninstallation

To uninstall ClaudeComputerCommander, you have two options:

### Option 1: Using the uninstall script (Recommended)

If you have the repository locally:
```bash
cd ClaudeComputerCommander
npm run uninstall
```

If you've installed it globally:
```bash
npx @jasondsmith72/desktop-commander uninstall
```

This will:
1. Create a backup of your Claude configuration file
2. Remove all references to desktopCommander from the configuration
3. Log the changes made for reference

### Option 2: Manual uninstallation

1. Open your Claude Desktop configuration file:
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`

2. Remove the `desktopCommander` entry from the `mcpServers` section.

3. Restart Claude Desktop.

4. If you installed the package globally, uninstall it:
   ```bash
   npm uninstall -g @jasondsmith72/desktop-commander
   ```

## New Enhanced Features

### Web Configuration Interface

Access the web-based configuration interface by running:

```
start_web_ui
```

This opens a browser interface where you can:
- Configure security settings
- Manage command aliases
- Control integrations with other MCP servers
- View system statistics
- Check for updates

### File Versioning System

Create automatic backups of files before modifications:

```
backup_file path="/path/to/yourfile.txt"
```

List available versions:

```
get_file_versions path="/path/to/yourfile.txt"
```

Restore a previous version:

```
restore_version path="/path/to/yourfile.txt" versionId="version-uuid"
```

Compare versions:

```
compare_versions path="/path/to/yourfile.txt" versionId1="old-version" versionId2="new-version"
```

### Monitoring Dashboard

Start the monitoring dashboard:

```
start_monitoring_dashboard
```

The dashboard shows:
- Command history
- File modifications
- Backup statistics
- System status

### Command Aliases

Create shortcuts for frequently used commands:

```
aliases
```

This lists all available aliases. Common examples:
- `ls` for listing directories
- `cat` for reading files
- `mkdir` for creating directories
- `dashboard` for starting the monitoring dashboard

### Enhanced Security

Set permission levels for directories:

```
security/permissions
```

Permission levels include:
- No Access (0)
- Read-Only (1)
- Read & Write (2)
- Read, Write & Execute (3)
- Full Access (4)

### Integration with Other MCP Servers

Enable or list other MCP servers:

```
integrations
```

Supported integrations:
- puppeteer
- memory
- github
- weather
- brave_search
- fetch

## Configuration

### Allowed Directories
By default, Claude can only access:
1. The current working directory (where the server is running from)
2. The user's home directory

You can customize this by editing the `config.json` file in the root of the project:

```json
{
  "blockedCommands": [
    "format",
    "mount",
    "umount",
    ...
  ],
  "allowedDirectories": [
    "~",                 // User's home directory
    "~/Documents",       // Documents folder
    "~/Projects",        // Projects folder
    ".",                 // Current working directory
    "/path/to/folder"    // Any absolute path
  ]
}
```

**Notes on allowed directories:**
- Use `~` to refer to the user's home directory
- Use `.` to refer to the current working directory
- You can specify absolute paths as well
- For security reasons, each path is validated before access is granted

### Blocked Commands
You can configure which commands are blocked by editing the `blockedCommands` array in `config.json`:

```json
{
  "blockedCommands": [
    "format",
    "mount",
    "umount",
    "mkfs",
    "fdisk",
    "dd",
    "sudo",
    "su",
    ...
  ]
}
```

## Usage

The server provides these tool categories:

### Terminal Tools
- `execute_command`: Run commands with configurable timeout
- `read_output`: Get output from long-running commands
- `force_terminate`: Stop running command sessions
- `list_sessions`: View active command sessions
- `list_processes`: View system processes
- `kill_process`: Terminate processes by PID
- `block_command`/`unblock_command`: Manage command blacklist

### Filesystem Tools
- `read_file`/`write_file`: File operations
- `create_directory`/`list_directory`: Directory management  
- `move_file`: Move/rename files
- `search_files`: Pattern-based file search
- `get_file_info`: File metadata
- `list_allowed_directories`: View which directories the server can access

### Edit Tools
- `edit_block`: Apply surgical text replacements (best for changes <20% of file size)
- `write_file`: Complete file rewrites (best for large changes >20% or when edit_block fails)

### Backup Tools
- `backup_file`: Create a backup of a file before modification
- `restore_version`: Restore a specific version of a file
- `get_file_versions`: Get version history for a file
- `compare_versions`: Compare different versions of a file
- `get_backup_stats`: Get backup system statistics

### Monitoring Tools
- `start_monitoring_dashboard`: Start the monitoring web interface
- `stop_monitoring_dashboard`: Stop the monitoring web interface
- `get_monitoring_status`: Get monitoring dashboard status

### Web UI Tools
- `start_web_ui`: Start the web configuration interface
- `stop_web_ui`: Stop the web configuration interface
- `get_web_ui_status`: Get web UI status

### Update Tools
- `check_for_updates`: Check if updates are available
- `perform_update`: Perform an update to the latest version

Search/Replace Block Format:
```
filepath.ext
<<<<<<< SEARCH
existing code to replace
=======
new code to insert
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

## Handling Long-Running Commands

For commands that may take a while:

1. `execute_command` returns after timeout with initial output
2. Command continues in background
3. Use `read_output` with PID to get new output
4. Use `force_terminate` to stop if needed

## Troubleshooting

If you encounter issues:

1. Check the monitoring dashboard for error logs
2. Verify permissions in the configuration UI
3. Run `check_for_updates` to ensure you have the latest version
4. Visit the web configuration interface for detailed system status
5. Ensure your desired file paths are in the allowed directories configuration
6. If you're getting "access denied" errors, use the `list_allowed_directories` tool to see which directories are accessible

## Contributing

If you find this project useful, please consider giving it a ⭐ star on GitHub! This helps others discover the project and encourages further development.

We welcome contributions from the community! Whether you've found a bug, have a feature request, or want to contribute code, here's how you can help:

- **Found a bug?** Open an issue at [github.com/jasondsmith72/ClaudeComputerCommander/issues](https://github.com/jasondsmith72/ClaudeComputerCommander/issues)
- **Have a feature idea?** Submit a feature request in the issues section
- **Want to contribute code?** Fork the repository, create a branch, and submit a pull request
- **Questions or discussions?** Start a discussion in the GitHub Discussions tab

All contributions, big or small, are greatly appreciated!

## License

MIT
