# Privacy Policy for DesktopCommanderMCP

This privacy policy explains how DesktopCommanderMCP collects and uses telemetry data to improve the application.

## Data Collection

DesktopCommanderMCP collects limited telemetry data to help us understand usage patterns, detect errors, and improve the tool. **Data collection is opt-out** — it is enabled by default but can be easily disabled (see [User Control](#user-control-opt-out)).

Our telemetry system is designed to be privacy-focused:
- We collect only the minimum information necessary for product improvement
- We do not collect directly identifying information such as names, email addresses, usernames, or file paths
- We use a pseudonymous identifier (random UUID) for analytics, which under GDPR is considered personal data but cannot directly identify you

### What We Collect

#### Pseudonymous Client ID
- **Client ID**: A randomly generated UUID that persists between sessions.
    - **Purpose**: Used to calculate monthly active users (MAU), retention metrics, and understand usage patterns over time.
    - **Privacy Design**: This ID is not derived from hardware or personal information. It is included with telemetry events to enable aggregate analysis. It cannot identify you personally but does allow us to understand usage patterns across sessions.

#### Application Usage Events
- **Event name**: The specific operation or action performed
- **Timestamp**: When the event occurred
- **Platform information**: Your operating system type (e.g., Windows, macOS, Linux)
- **App version**: The version of DesktopCommanderMCP you're using
- **Client information**: Name and version of the MCP client (e.g., "Claude Desktop", "VS Code")

#### Installation and Setup Information
- **Node.js version**: Version of Node.js runtime
- **NPM version**: Version of the NPM package manager
- **Installation method**: How the tool was installed (npx, global, direct, DXT)
- **Shell environment**: Type of shell being used (bash, zsh, PowerShell, etc.)
- **Setup status**: Success or failure of installation steps

#### Container/Environment Metadata
- **Container detection**: Whether running in Docker or other container environment
- **Container type**: Type of containerization (Docker, Kubernetes, etc.)
- **Runtime source**: How the application was launched (npx, direct, etc.)
- Note: Container names and image names are sanitized to remove unique identifiers

#### File Operation Metrics
- **File extensions**: Types of files being accessed (e.g., .js, .py, .txt)
- **File sizes**: Size of files being read or written
- **Operation type**: Type of file operation (read, write, edit)
- **Operation status**: Success or failure of operations

#### Terminal Command Metrics
- **Base command name**: The command being run (e.g., "python", "node"), without arguments
- **Command status**: Success or failure of command execution
- **Execution time**: How long commands take to run

#### Error Information
- **Error types**: Categories of errors encountered (e.g., ENOENT, EPERM)
- **Error codes**: System error codes when available
- **Sanitized error messages**: Error descriptions with file paths and usernames removed
- **Operation context**: Which operation encountered the error

### What We DO NOT Collect

We explicitly DO NOT collect:
- **File paths**: Full paths or filenames of accessed files
- **File contents**: The actual data or code in your files
- **Command arguments**: Arguments or parameters passed to terminal commands
- **Usernames**: System or account usernames
- **Personal information**: Any personally identifiable information

### IP Addresses

We do not store or have access to IP addresses. However, our analytics provider (Google Analytics) receives IP addresses as part of standard HTTPS requests. Google Analytics 4 automatically truncates/anonymizes IP addresses before storage, and we do not have access to this data in any form.

## Analytics Provider

We use **Google Analytics 4** to process telemetry data. Data is sent securely via HTTPS to Google's servers. Google's privacy policy applies to their processing of this data: https://policies.google.com/privacy

## Data Usage

The collected data is used for:

- Understanding how the application is used
- Calculating retention and engagement metrics
- Identifying common errors or issues
- Measuring feature adoption and performance
- Guiding development priorities
- Improving overall user experience

## Privacy Protection

We take your privacy seriously:

- The client ID is a randomly generated UUID, not derived from your machine or personal information
- The UUID is stored locally in your configuration file (`~/.desktop-commander/config.json`)
- All data is sent securely via HTTPS
- We implement robust sanitization of all error data to ensure file paths, usernames, and other potential PII are removed before transmission
- All collected information is carefully filtered to remove any potentially sensitive data
- We maintain data minimization principles - only collecting what's necessary for product improvement

## Data Retention

Telemetry data is retained for a period of 14 months, after which it is automatically deleted from Google Analytics.

## User Control (Opt-Out)

Data collection is **opt-out** — telemetry is enabled by default but you can disable it at any time using either method:

**Option 1: Ask the AI**
Simply ask Claude (or your AI assistant) to disable telemetry:
> "Please disable Desktop Commander telemetryEnabled in config"

The AI will update your configuration automatically.

**Option 2: Manual configuration**
1. Edit your configuration file at `~/.desktop-commander/config.json`
2. Set `"telemetryEnabled": false`
3. Restart the application

When telemetry is disabled, no data will be sent. Your client ID (UUID) will remain in your config file but won't be used unless you re-enable telemetry.

## Legal Basis

We collect this data based on our legitimate interest (GDPR Article 6(1)(f)) to improve our software. Since we use a randomly generated pseudonymous UUID rather than any personal identifier, and implement comprehensive data sanitization, the privacy impact is minimal while allowing us to gather important usage data for product improvement.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted in this document and noted in release notes for versions that include telemetry changes.

For transparency, we maintain a changelog of material changes below.

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| December 8, 2025 | 1.1 | Clarified client ID is pseudonymous (not anonymous) and is included with events. Added missing collected data: client info, container metadata, file sizes. Added Google Analytics disclosure. Clarified opt-out data collection model and added AI-assisted opt-out method. Added Your Rights section with instructions for data access/deletion requests. |
| April 29, 2025 | 1.0 | Initial privacy policy |

## Your Rights

Depending on your location, you may have rights to:
- Access the data we hold about you
- Request deletion of your data
- Object to processing
- Withdraw consent (by disabling telemetry)

### Exercising Your Rights

To request access to or deletion of your data, contact legal@desktopcommander.app with your client ID (UUID).

**Finding your UUID:** Simply ask Claude (or your AI assistant):
> "Show me my Desktop Commander config and tell me my client id"

Your client ID will be displayed in the response.

Alternatively, check your config file directly:
- macOS/Linux: `~/.desktop-commander/config.json`
- Windows: `%USERPROFILE%\.desktop-commander\config.json`

Look for the `clientId` field.

**Important:** Because we do not collect emails, names, or other identifying information, we can only process data requests when you provide your UUID. This design protects your privacy but means we cannot verify identity through other means. If you have lost your UUID and uninstalled Desktop Commander, we have no way to link any data to you (and neither does anyone else).

We aim to respond to privacy inquiries within 30 days.

## Contact

- **General questions:** Open an issue on our [GitHub repository](https://github.com/wonderwhy-er/DesktopCommanderMCP)
- **Privacy concerns or legal matters:** legal@desktopcommander.app

---

Last updated: December 8, 2025
