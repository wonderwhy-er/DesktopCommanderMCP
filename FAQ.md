# Frequently Asked Questions (FAQ)

This document provides answers to the most commonly asked questions about Claude Desktop Commander (also known as ClaudeComputerCommander). If you can't find an answer to your question here, please join our [Discord server](https://discord.gg/kQ27sNnZr7) for additional support or [open a GitHub issue](https://github.com/wonderwhy-er/ClaudeComputerCommander/issues/new).

> **Note**: For a more user-friendly version of this FAQ, visit our [website FAQ section](https://desktopcommander.app#faq).

## Table of Contents

- [General Information](#general-information)
  - [What is Claude Desktop Commander?](#what-is-claude-desktop-commander)
  - [How does it differ from coding tools like Cursor or Windsurf?](#how-does-it-differ-from-coding-tools-like-cursor-or-windsurf)
  - [What is an MCP?](#what-is-an-mcp)
  - [Is this an official Anthropic product?](#is-this-an-official-anthropic-product)

- [Cost & Value](#cost--value)
  - [How much does it cost to use Claude Desktop Commander?](#how-much-does-it-cost-to-use-claude-desktop-commander)
  - [How does the pricing compare to Claude Code or other AI coding tools?](#how-does-the-pricing-compare-to-claude-code-or-other-ai-coding-tools)
  - [Do I need API credits to use this tool?](#do-i-need-api-credits-to-use-this-tool)

- [Installation & Setup](#installation--setup)
  - [What are the prerequisites for using Claude Desktop Commander?](#what-are-the-prerequisites-for-using-claude-desktop-commander)
  - [How do I install Claude Desktop Commander?](#how-do-i-install-claude-desktop-commander)
  - [How do I update to the latest version?](#how-do-i-update-to-the-latest-version)
  - [Which operating systems does it support?](#which-operating-systems-does-it-support)
  - [How do I get started after installing Desktop Commander?](#how-do-i-get-started-after-installing-desktop-commander)

- [Features & Capabilities](#features--capabilities)
  - [What can I do with Claude Desktop Commander?](#what-can-i-do-with-claude-desktop-commander)
  - [Can Claude analyze my CSV/Excel files directly?](#can-claude-analyze-my-csvexcel-files-directly)
  - [Can Claude connect to remote servers?](#can-claude-connect-to-remote-servers)
  - [Does Claude save temporary files when running code?](#does-claude-save-temporary-files-when-running-code)
  - [What programming languages can Claude run interactively?](#what-programming-languages-can-claude-run-interactively)
  - [Can Claude handle multi-step operations?](#can-claude-handle-multi-step-operations)
  - [How does it handle file editing?](#how-does-it-handle-file-editing)
  - [Can it help me understand complex codebases?](#can-it-help-me-understand-complex-codebases)
  - [How does it handle long-running commands?](#how-does-it-handle-long-running-commands)
  - [Can I use it for non-coding tasks?](#can-i-use-it-for-non-coding-tasks)
  - [How does Desktop Commander collect feedback and usage data?](#how-does-desktop-commander-collect-feedback-and-usage-data)
  - [Can I disable the new usage analytics?](#can-i-disable-the-new-usage-analytics)
  - [How do I stop seeing feedback prompts?](#how-do-i-stop-seeing-feedback-prompts)
  - [Does Desktop Commander work in Docker containers?](#does-desktop-commander-work-in-docker-containers)

- [Security & Permissions](#security--permissions)
  - [Is it safe to give Claude access to my file system?](#is-it-safe-to-give-claude-access-to-my-file-system)
  - [Can I control which directories Claude can access?](#can-i-control-which-directories-claude-can-access)
  - [What commands are blocked by default?](#what-commands-are-blocked-by-default)

- [Usage Scenarios](#usage-scenarios)
  - [Is it suitable for large codebases?](#is-it-suitable-for-large-codebases)
  - [Can it work with multiple repositories simultaneously?](#can-it-work-with-multiple-repositories-simultaneously)
  - [Is it suitable for non-technical users?](#is-it-suitable-for-non-technical-users)

- [Troubleshooting](#troubleshooting)
  - [Claude says it doesn't have permission to access my files/directories](#claude-says-it-doesnt-have-permission-to-access-my-filesdirectories)
  - [Claude keeps hitting token/output limits](#claude-keeps-hitting-tokenoutput-limits)
  - [Installation fails on my system](#installation-fails-on-my-system)

- [Best Practices](#best-practices)
  - [What's the recommended workflow for coding?](#whats-the-recommended-workflow-for-coding)
  - [How can I manage changes to avoid losing work?](#how-can-i-manage-changes-to-avoid-losing-work)
  - [Should I still use a code editor?](#should-i-still-use-a-code-editor)

- [Comparison with Other Tools](#comparison-with-other-tools)
  - [How does this compare to VSCode extensions like Cline?](#how-does-this-compare-to-vscode-extensions-like-cline)
  - [Is this better than using Jupyter notebooks with Claude?](#is-this-better-than-using-jupyter-notebooks-with-claude)

---

## General Information

### What is Claude Desktop Commander?

Claude Desktop Commander is an MCP (Model Context Protocol) tool that allows Claude Desktop to access and control your computer's file system and terminal. It enables Claude to explore, read, and write files, execute commands, and manage processes - expanding Claude's capabilities beyond just conversation to become a comprehensive assistant that can work with your entire operating system.

### How does it differ from coding tools like Cursor or Windsurf?

Unlike tools like Cursor or Windsurf which are primarily designed as coding IDEs, Claude Desktop Commander works with Claude to provide a more flexible, solution-centric approach. It's not confined to a coding box - it can handle coding tasks but also excels at exploring codebases, drawing diagrams, running automation processes, and working with multiple projects simultaneously.

The main differences:
- Claude reads full files during exploration, ensuring it captures the complete structure
- Coding tools like Windsurf & Cursor chunk and index files, sometimes missing key relationships
- Claude generates and displays diagrams directly in chat
- Claude Desktop Commander allows you to work across your entire system, not just within coding environments
- Claude lets you execute the changes in one go, rather than requiring constant review and approval

### What is an MCP?

MCP stands for Model Context Protocol. It's a framework that allows AI language models like Claude to interact with external tools and services. MCPs give Claude the ability to perform actions in the real world - in this case, to read and write files, execute terminal commands, and manage processes on your computer.

### Is this an official Anthropic product?

No, Claude Desktop Commander is an independent, open-source project developed by Eduard Ruzga and other contributors. It's not an official Anthropic product, though it works with Anthropic's Claude Desktop application.

## Cost & Value

### How much does it cost to use Claude Desktop Commander?

Claude Desktop Commander itself is free and open-source. However, to use it, you need a Claude Pro subscription, which costs $20/month. There are no additional charges beyond this subscription fee.

### How does the pricing compare to Claude Code or other AI coding tools?

Claude Desktop Commander with Claude Pro is generally more cost-effective than alternatives:
- It costs a flat $20/month (Claude Pro subscription)
- Claude Code uses an API with per-token pricing, which users report can quickly become expensive (some report spending hundreds of dollars)
- Tools like Cursor or Windsurf have their own subscription costs that may be in addition to other AI services

Many users find the flat fee approach more predictable and often more affordable for regular usage.

### Do I need API credits to use this tool?

No. Claude Desktop Commander works with the Claude Desktop application's standard Pro subscription, not with API calls. You won't incur additional costs beyond the Claude Pro subscription fee.

## Installation & Setup

### What are the prerequisites for using Claude Desktop Commander?

You'll need:
- Node.js version 18 or higher installed on your system
- Claude Desktop installed and running
- A Claude Pro subscription ($20/month)

### How do I install Claude Desktop Commander?

There are several ways to install:

**Option 1: Via Smithery**
```bash
npx -y @smithery/cli install @wonderwhy-er/desktop-commander --client claude
```

**Option 2: Direct installation**
```bash
npx @wonderwhy-er/desktop-commander setup
```

**Option 3: Manual configuration**
Add the MCP server to your claude_desktop_config.json (on Mac, found at ~/Library/Application\ Support/Claude/claude_desktop_config.json):
```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "npx",
      "args": [
        "-y",
        "@wonderwhy-er/desktop-commander@latest"
      ]
    }
  }
}
```

**Option 4: Local installation**
```bash
git clone https://github.com/wonderwhy-er/ClaudeComputerCommander.git
cd ClaudeComputerCommander
npm run setup
```

After installation, restart Claude Desktop to see the new tools.

### How do I update to the latest version?

In most cases, simply restarting Claude should be enough, as it uses npx which checks for and installs new versions automatically. If you're having issues, you can run the installation command again, which will update to the latest version.

Make sure you have Node.js version 18 or higher installed, as older versions may cause issues with the update process.

### Which operating systems does it support?

Claude Desktop Commander works with:
- Windows (ongoing improvements for better Windows support)
- macOS
- Linux (with ongoing enhancements for various distributions)

Work is in progress to improve WSL (Windows Subsystem for Linux) integration and add SSH support for remote servers.

### How do I get started after installing Desktop Commander?

After installation, Desktop Commander includes intelligent onboarding to help new users discover its capabilities:

**Automatic Onboarding:** When you're a new user (fewer than 10 successful commands), Claude will automatically offer helpful getting-started guidance and tutorials after you use Desktop Commander successfully.

**Manual Onboarding:** You can also request onboarding help at any time by simply asking Claude:
- "Help me get started with Desktop Commander"
- "Show me Desktop Commander examples"
- "What can I do with Desktop Commander?"

**Starter Examples:** Claude will show you beginner-friendly tutorials like:
- Organizing your Downloads folder
- Analyzing CSV files
- Setting up GitHub Actions
- Exploring codebases
- And more hands-on examples

## Features & Capabilities

### What can I do with Claude Desktop Commander?

The tool enables a wide range of tasks:

**Code-related tasks:**
- Explore and understand codebases, including generating diagrams
- Read, write, and edit files with surgical precision
- Work with multiple codebases or projects simultaneously
- Perform comprehensive code searches across directories with timeout protection
- Debug issues by comparing codebases
- Fetch and analyze content from URLs

**Automation tasks:**
- Run and manage terminal commands, including long-running processes
- Execute automation scripts and workflows
- Compress files, convert formats, encode videos
- Monitor system processes

**Documentation tasks:**
- Generate documentation from code
- Create diagrams of system architecture
- Analyze and summarize codebases
- Produce reports on code quality or structure

### Can Claude analyze my CSV/Excel files directly?

Yes! Just ask Claude to analyze any data file. It will write and execute Python/Node code in memory to process your data and show results instantly.

### Can Claude connect to remote servers?

Yes! Claude can start SSH connections, databases, or other programs and continue interacting with them throughout your conversation.

### Does Claude save temporary files when running code?

If you ask. Code can run in memory. When you ask for data analysis, Claude executes Python/R code directly without creating files on your disk. Or creating if you ask.

### What programming languages can Claude run interactively?

Python, Node.js, R, Julia, and shell commands. Any interactive terminal REPL environments. Perfect for data analysis, web development, statistics, and system administration.

### Can Claude handle multi-step operations?

Yes! Claude can start a program (like SSH or database connection) and send multiple commands to it, maintaining context throughout the session.

### How does it handle file editing and URL content?

Claude Desktop Commander provides two main approaches to file editing and supports URL content:

1. **Surgical text replacements (`edit_block`):**
   - Best for small changes (<20% of file size)
   - More precise and less likely to introduce errors
   - Uses a special format to identify text to replace:
   ```
   filepath.ext
   <<<<<<< SEARCH
   existing code to replace
   =======
   new code to insert
   >>>>>>> REPLACE
   ```

2. **Complete file rewrites (`write_file`):**
   - Best for large changes (>20% of file size) or when edit_block fails
   - Replaces the entire content of a file

3. **URL content retrieval (`read_file` with `isUrl: true`):**
   - Fetch content from web resources
   - Supports both text and image content from URLs
   - Uses a 30-second timeout to prevent hanging on slow connections

It also supports pattern-based replacements across multiple files.

### Can it help me understand complex codebases?

Yes, one of its strengths is codebase exploration. Claude can:
- Navigate through folders and files
- Read and understand code
- Generate diagrams showing relationships between components
- Create summaries of key functionalities
- Identify patterns and architecture
- Explain complex parts of the code

This makes it particularly useful for onboarding to new projects or reviewing unfamiliar repositories.

### How does it handle long-running commands and searches?

Claude Desktop Commander has a sophisticated system for managing commands and operations that may take a while to complete:

1. The `execute_command` function returns after a timeout with initial output
2. The command continues running in the background
3. You can use `read_output` with the PID to get new output as it becomes available
4. You can use `force_terminate` to stop the command if needed

For search operations:
1. `start_search` begins a streaming search and returns immediately with a session ID
2. `get_more_search_results` retrieves results progressively with pagination support
3. `stop_search` allows you to cancel long-running searches
4. Search sessions auto-cleanup after 5 minutes if not stopped manually

This allows Claude to manage processes that would normally exceed conversation timeouts, such as video encoding, large file operations, complex builds, or extensive searches.

### Can I use it for non-coding tasks?

Absolutely. While it excels at coding-related tasks, Claude Desktop Commander can be used for many system tasks:
- File organization and management
- Media processing (video compression, image conversion)
- System monitoring and maintenance
- Running and managing any terminal-based tools
- Data processing and analysis

### How does Desktop Commander collect feedback and usage data?

Desktop Commander has three separate data collection systems:

**1. Personal Usage Analytics (Local Only, Always Active):**
- Collects usage statistics stored **locally on your machine only**
- Use the `get_usage_stats` tool to view your personal usage patterns, success rates, and performance metrics
- **This data never leaves your computer** - it's for your own analysis and tool functionality
- **Cannot be disabled** - these are needed for the tool to function properly

**2. Anonymous Telemetry (External, Opt-Out Available):**
- Sends anonymous usage data to analytics services to help improve the tool
- No personal information, file contents, file paths, or command arguments are collected
- **Can be disabled** by asking: **"Disable telemetry"**

**3. Feedback System (User Controlled):**
- Use the `give_feedback_to_desktop_commander` tool to provide feedback about Desktop Commander
- Opens a browser-based feedback form to send suggestions and feedback to the development team
- Pre-fills basic usage statistics (tool call count, days using, platform) for context
- **You can edit or remove any pre-filled information** before submitting
- **Completely optional** - you choose when and if to participate

### Can I disable the new usage analytics?

**Local usage analytics cannot be disabled** - they are required for the tool to function properly and power features like `get_usage_stats`.

**Anonymous telemetry can be disabled** by asking in chat: **"Disable telemetry"**. This stops sending anonymous usage data to analytics services, but local usage tracking continues.

**Feedback system is always optional** - you control when and if to use it, and can edit any pre-filled information.

### How do I stop seeing feedback prompts?

If you don't want to see periodic feedback requests, you can disable them:

**Simple method:** Ask in chat: **"Set feedbackGiven to true"**

This will stop Desktop Commander from showing feedback prompts while keeping all other functionality intact.

### Does Desktop Commander work in Docker containers?

Yes! Desktop Commander can be run in Docker containers for **complete isolation from your host system**, providing **zero risk to your computer**. This is perfect for testing, development, or when you want complete sandboxing.

**Installation:**
1. Install Docker for Windows/Mac from [docker.com](https://www.docker.com/products/docker-desktop/)
2. Visit: https://hub.docker.com/mcp/server/desktop-commander/manual
3. Choose Claude Desktop or other client you are using and copy the provided MCP toolkit commands to terminal or click "Standalone" to get the config JSON for your client

**Benefits:**
- Complete isolation from your host system
- No risk to your computer or files
- Consistent environment across different machines
- Easy cleanup - just remove the container when done

### Can I read files from the end like Unix tail?

Yes! Recent updates added negative offset support:

```javascript
// Read last 10 lines
read_file({ path: "server.log", offset: -10 })
```

This is useful for checking recent log entries or file endings without reading the entire content.

### Can I use Desktop Commander in any MCP client outside of Claude?

Yes, you can install Desktop Commander MCP on other clients that support MCP, including:
- Cursor
- Windsurf 
- DeepChat
- Any other client with MCP support

You can use any model available for that client with Desktop Commander.

**However, important caveats:**
- **Unexpected behavior**: Desktop Commander can work unexpectedly on other clients due to differences in system prompts and potential conflicts with their own built-in tools
- **Not optimized for other clients**: Desktop Commander is primarily designed and tested with Claude Desktop
- **Varying results**: The experience may differ significantly from the Claude Desktop experience

**If you try other clients:**
- Test carefully with non-critical projects first
- Be aware that some features may not work as expected
- Consider reporting your experience to help improve compatibility

We welcome feedback from users who try Desktop Commander with other MCP clients to help us understand compatibility and improve the experience across different platforms.

## Security & Permissions

> **Important**: For current security limitations and vulnerability reporting, see our [Security Policy](SECURITY.md).

### Is it safe to give Claude access to my file system?

Claude Desktop Commander has known security limitations:

- Directory restrictions can be bypassed via symlinks and terminal commands
- Command blocking can be bypassed via command substitution and absolute paths  
- Claude can only perform actions that your user account has permission to do

> **For production use requiring security**: Use the [Docker installation](#option-6-docker-installation-🐳-⭐-auto-updates-no-nodejs-required) with selective folder mounting for complete isolation from your host system.

### Can I control which directories Claude can access?

Directory access controls exist but have known bypass vulnerabilities. For secure usage, we recommend the Docker installation which provides complete isolation with controlled folder mounting.

### What commands are blocked by default?

Command blocking exists but can be bypassed through various methods. The current system blocks dangerous commands like `rm`, `sudo`, `format`, etc., but these restrictions can be circumvented.

### How do I report security vulnerabilities?

Please create a [GitHub Issue](https://github.com/wonderwhy-er/DesktopCommanderMCP/issues) with detailed information about any security vulnerabilities you discover. See our [Security Policy](SECURITY.md) for full guidelines.

Claude Desktop Commander doesn't have a pre-defined blocklist, but you can use the `block_command` and `unblock_command` functions to manage which commands Claude can execute. It's recommended to block commands that could potentially be destructive, such as `rm -rf` or `format`.

### Why is the fileWriteLineLimit set to 50 by default? What is the maximum value?

The `fileWriteLineLimit` setting is set to 50 lines by default for these specific reasons:

**Why 50 lines is the default:**
- **AIs are wasteful with tokens**: Instead of doing two small edits in a file, AIs may decide to rewrite the whole thing. We're trying to force AIs to do things in smaller changes as it saves time and tokens
- **Claude UX message limits**: There are limits within one message and hitting "Continue" does not really work. What we're trying here is to make AI work in smaller chunks so when you hit that limit, multiple chunks have succeeded and that work is not lost - it just needs to restart from the last chunk

**What is the maximum value:**
- You can set it to thousands if you want - there's no technical restriction

**Configuration examples:**
```javascript
// You can set it very high if needed
set_config_value({ "key": "fileWriteLineLimit", "value": 2000 })

// Or keep it small to force efficient behavior
set_config_value({ "key": "fileWriteLineLimit", "value": 25 })
```

**Why the chunking approach works:**
When you exceed the limit, the system automatically suggests breaking operations into chunks:
1. First chunk: `write_file(path, firstChunk, {mode: 'rewrite'})`
2. Additional chunks: `write_file(path, nextChunk, {mode: 'append'})`

This way, if Claude hits message limits partway through, the completed chunks are preserved and you only need to restart from where it left off, rather than losing all the work.

## Usage Scenarios

### Is it suitable for large codebases?

Yes, users have reported success with very large codebases (one user mentioned 44k files with 11 million code lines). Claude can effectively:
- Navigate and understand the structure
- Find specific information using the search tools
- Make targeted changes across multiple files
- Generate diagrams and documentation to help visualization

For extremely large monorepo projects, you may need to direct Claude to specific directories or components rather than trying to process the entire codebase at once.

### Can it work with multiple repositories simultaneously?

Yes, one of Claude Desktop Commander's strengths is its ability to work across different projects or repositories at the same time. This is particularly useful for:
- Migrating features between codebases
- Comparing implementations
- Applying consistent changes across multiple projects
- Understanding relationships between separate but related components

### Is it suitable for non-technical users?

Claude Desktop Commander requires some basic technical knowledge, particularly:
- Understanding of file systems
- Basic terminal/command line knowledge
- Ability to install and configure Node.js applications

For complete beginners, platforms like Loveable might be easier as they handle deployment and server-side aspects. However, if you're comfortable with basic technical concepts and want more control, Claude Desktop Commander can be a good option, especially if you've had issues with other platforms.

## Troubleshooting

Before diving into specific issues, check the [GitHub issues page](https://github.com/wonderwhy-er/ClaudeComputerCommander/issues) to see if your problem has already been reported and if there are any solutions or workarounds. If you discover a new issue, please consider [opening a GitHub issue](https://github.com/wonderwhy-er/ClaudeComputerCommander/issues/new) to help improve the tool for everyone.

### Claude says it doesn't have permission to access my files/directories

Recent updates have removed directory restrictions. If you're still experiencing this issue:
1. Make sure you've installed the latest version
2. Restart Claude Desktop completely
3. When Claude asks for permission to use tools, approve for the entire chat
4. Check if there are any specific permission issues with the directory in question (file permissions, etc.)

### Claude keeps hitting token/output limits

Claude Desktop has certain limits on message size. When working with large codebases or extensive outputs, you might encounter these limits. Some strategies to work around them:

1. Ask Claude to focus on specific parts of the codebase rather than the entire thing
2. For long-running commands, use the PID to check progress periodically rather than keeping the entire output
3. Request summarized information instead of full file contents
4. Break complex tasks into smaller steps
5. Create new chats for different aspects of your project

### Installation fails on my system

If you're having trouble installing Claude Desktop Commander:

1. Check Node.js version: `node -v` (should be v18 or higher)
2. Ensure you have proper permissions to install npm packages
3. On Windows, try running your terminal as Administrator
4. Check if there are any specific errors in the installation output
5. Try the manual installation method (Option 4 in the installation instructions)

For persistent issues, join the [Discord community](https://discord.gg/kQ27sNnZr7) for assistance.

## Best Practices

### What's the recommended workflow for coding?

Many users recommend the following workflow:

1. **Plan first:** Ask Claude to analyze the problem and outline a solution before making changes
2. **Focus on working code:** Let Claude implement changes to get the code working first
3. **Review after it works:** Only review the code in detail after confirming it runs
4. **Version control:** Use git or another version control system to track changes
5. **Stage and commit:** Make regular commits after verifying changes work
6. **Test integration:** Have Claude run tests to ensure changes don't break existing functionality

For larger projects, consider asking Claude to implement changes in logical chunks rather than all at once.

### How can I manage changes to avoid losing work?

To ensure you don't lose important work:

1. Always use version control (git) when working on code projects
2. Stage changes and commit when appropriate to be able to roll back if needed
3. For significant changes, consider having Claude create a new branch first
4. Review changes before committing them, especially for critical code
5. Ask Claude to explain its changes and reasoning
6. Back up important files before major modifications
7. Use the `edit_block` approach for precise, controlled changes when possible

### Should I still use a code editor?

Yes, for most users, having a code editor is still valuable. Claude Desktop Commander works well alongside traditional development tools, rather than completely replacing them.

Typical workflow:
1. Use Claude to implement changes or explore code
2. Review the changes in your preferred code editor
3. Make any additional adjustments manually if needed
4. Use your editor for debugging, advanced features, or specific language tooling
5. Commit changes using your normal workflow

Some users report reviewing code only after Claude has made it work, focusing on understanding and quality rather than writing from scratch.

## Comparison with Other Tools

### How does this compare to VSCode extensions like Cline?

Tools like Cline are great options that integrate directly with VSCode. The main differences are:

**Claude Desktop Commander:**
- Works across your entire system, not just within the editor
- Can handle automation, terminal commands, and long-running processes
- Fixed cost with Claude Pro subscription
- More flexible approach not tied to a specific editor
- Better for tasks beyond just coding

**Cline and similar extensions:**
- Tightly integrated with the editor experience
- May be more convenient for pure coding workflows
- Some extensions use API calls which can incur additional costs
- Better editor-specific features (syntax highlighting, IntelliSense integration)

Many users employ both, using the right tool for different tasks.

### Is this better than using Jupyter notebooks with Claude?

Jupyter notebooks and Claude Desktop Commander serve different purposes:

**Claude Desktop Commander:**
- System-wide access to files and terminal
- Can work with any project type or language
- Full development workflow support
- Better for production code and real projects

**Jupyter with Claude:**
- Better for data analysis and exploration
- Excellent for step-by-step learning and documentation
- Visual output for data visualization
- More structured for educational purposes

For data science or analysis projects, you might use both: Claude Desktop Commander for system tasks and code management, and Jupyter for interactive exploration and visualization.