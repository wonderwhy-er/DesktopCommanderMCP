# Privacy Policy for DesktopCommanderMCP

This privacy policy explains how DesktopCommanderMCP collects and uses telemetry data to improve the application.

## Data Collection

DesktopCommanderMCP collects limited telemetry data to help us understand usage patterns, detect errors, and improve the tool. Our telemetry system is designed to be privacy-focused, collecting only the minimum information necessary while avoiding any personally identifiable information.

### What We Collect

#### Anonymous Client ID
- **Anonymous client ID**: A randomly generated UUID that persists between sessions.
    - **Purpose**: Used solely to anonymously calculate monthly active users (MAU).
    - **Privacy Design**: It is *not* connected to any other telemetry event data to ensure that individual users cannot be identified or tracked.

#### Application Usage Events
- **Event name**: The specific operation or action performed
- **Timestamp**: When the event occurred
- **Platform information**: Your operating system type (e.g., Windows, macOS, Linux)
- **App version**: The version of DesktopCommanderMCP you're using

#### Installation and Setup Information
- **Node.js version**: Version of Node.js runtime
- **NPM version**: Version of the NPM package manager
- **Installation method**: How the tool was installed (npx, global, direct)
- **Shell environment**: Type of shell being used (bash, zsh, PowerShell, etc.)
- **Setup status**: Success or failure of installation steps

#### File Operation Metrics
- **File extensions**: Types of files being accessed (e.g., .js, .py, .txt)
- **Operation type**: Type of file operation (read, write, edit)
- **Operation status**: Success or failure of operations

#### Terminal Command Metrics
- **Command type**: Categories of commands being run
- **Command status**: Success or failure of command execution
- **Execution time**: How long commands take to run

#### Error Information
- **Error types**: Categories of errors encountered
- **Operation context**: Which operation encountered the error

### What We DO NOT Collect

We explicitly DO NOT collect:
- **File paths**: Full paths or filenames of accessed files
- **File contents**: The actual data or code in your files
- **Command arguments**: Arguments or parameters passed to terminal commands
- **IP addresses**: Your network information
- **Usernames**: System or account usernames
- **Personal information**: Any personally identifiable information

## Data Usage

The collected data is used for:

- Understanding how the application is used
- Identifying common errors or issues
- Measuring feature adoption and performance
- Guiding development priorities
- Improving overall user experience

## Privacy Protection

We take your privacy seriously:

- The client ID is a randomly generated UUID, not derived from your machine hardware ID
- The UUID is stored in your configuration file (`~/.claude-server-commander/config.json`)
- All data is sent securely via HTTPS to Google Analytics
- Data is only used in aggregate form for statistical analysis
- We implement robust sanitization of all error data to ensure file paths, usernames, and other potential PII are never included in telemetry
- All collected information is carefully filtered to remove any potentially sensitive data before transmission
- We maintain data minimization principles - only collecting what's needed
- All telemetry is processed in a way that does not connect it to specific individuals
- The anonymous client ID is isolated from other telemetry data to prevent any user tracking or profiling

## Data Retention

Telemetry data is retained for a period of 14 months, after which it is automatically deleted from Google Analytics.

## User Control

Telemetry is enabled by default, but you can disable it at any time:

1. Edit your configuration file at `~/.claude-server-commander/config.json`
2. Set `"telemetryEnabled": false`
3. Restart the application

When telemetry is disabled, no data will be sent to our servers. Your client ID (UUID) will remain in your config file but won't be used unless you re-enable telemetry.

## Legal Basis

We collect this data based on our legitimate interest (GDPR Article 6(1)(f)) to improve our software. Since we use a randomly generated UUID rather than any personal identifier, the privacy impact is minimal while allowing us to gather important usage data.

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be posted in this document and in release notes.

## Contact

If you have any questions about this privacy policy or our data practices, please open an issue on our GitHub repository.

Last updated: April 27, 2025