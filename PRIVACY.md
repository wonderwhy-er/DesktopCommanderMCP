# Privacy Policy for Desktop Commander

**Last updated: October 23, 2026**

## Introduction

We at Desktop Commander are committed to respecting your privacy and keeping secure any information collected through our software. This privacy policy explains how we collect, use, and protect telemetry data when you use Desktop Commander, and documents separate operational network requests the application performs.

Desktop Commander is an open-source MCP (Model Context Protocol) server that runs locally on your machine. Most of this policy describes the optional telemetry data we collect to improve the application; operational network traffic is described separately below.

## Data Collection

Desktop Commander collects limited telemetry data to help us understand usage patterns, detect errors, and improve the tool. **Telemetry collection is opt-out** — it is enabled by default but can be easily disabled (see [User Control](#user-control-opt-out)).

Our telemetry system is designed to be privacy-focused:
- We collect only the minimum information necessary for product improvement
- We do not collect directly identifying information such as names, email addresses, usernames, or file paths
- We use a pseudonymous identifier (random UUID) for analytics, which cannot directly identify you but allows us to understand usage patterns

### Operational Network Requests

Separately from telemetry, Desktop Commander performs network requests used for runtime configuration and PDF support:

- By default, it requests a public feature-flag document from `https://desktopcommander.app/flags/v2/production.json` during startup and refreshes it periodically. The endpoint can be overridden with `DC_FLAG_URL`. The application request does not include the telemetry client ID, file contents, file paths, or command arguments. The returned flags are cached locally.
- After MCP initialization, it checks for a compatible Chrome installation used by `write_pdf`. If no compatible cached or system Chrome is found, `@puppeteer/browsers` resolves and downloads a stable Chrome build in the background.

These requests are operational traffic rather than telemetry events. They are not controlled by the `telemetryEnabled` setting and therefore still occur when telemetry is disabled. As with any network request, the receiving services and network infrastructure can observe ordinary connection metadata such as the source IP address and HTTP/TLS metadata.

### What We Collect

#### Pseudonymous Client ID
- **Client ID**: A randomly generated UUID that persists between sessions
- **Purpose**: Used to calculate monthly active users (MAU), retention metrics, and understand usage patterns over time
- **Privacy Design**: This ID is not derived from hardware or personal information. It cannot identify you personally but does allow us to understand usage patterns across sessions.

#### Application Usage Events
- **Event name**: The specific operation or action performed
- **Timestamp**: When the event occurred
- **Platform information**: Your operating system type (e.g., Windows, macOS, Linux)
- **App version**: The version of Desktop Commander you're using
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

### What We DO NOT Collect in Telemetry

Our telemetry does not collect:
- **File paths**: Full paths or filenames of accessed files
- **File contents**: The actual data or code in your files
- **Command arguments**: Arguments or parameters passed to terminal commands
- **Usernames**: System or account usernames
- **Personal information**: Any personally identifiable information
- **Sensitive data**: We do not knowingly collect sensitive or special category personal information

### Telemetry IP Addresses

For telemetry, we do not store or have access to IP addresses. Our analytics provider (Google Analytics) receives IP addresses as part of standard HTTPS requests but automatically anonymizes them before storage. We do not have access to this data in any form. This statement is specific to telemetry; the operational network requests described above expose ordinary connection metadata to their receiving services and network infrastructure.

### Children

Desktop Commander is not directed at children under the age of 18. We do not knowingly collect information from children. If we learn that we have collected personal data from a child, we will take steps to delete that information.

## How We Use Data

The collected data is used for:
- Understanding how the application is used
- Calculating retention and engagement metrics
- Identifying common errors or issues
- Measuring feature adoption and performance
- Guiding development priorities
- Improving overall user experience

We may aggregate or de-identify data so that it no longer identifies any individual, and use that information for the purposes described above.


## How We Share Data

We may share your data in the following circumstances:

**Service Providers**: We use Google Analytics 4 to process telemetry data. Data is sent securely via HTTPS to Google's servers. We have appropriate data processing agreements in place with our service providers. Google's privacy policy applies to their processing: https://policies.google.com/privacy

**Legal Compliance**: We may disclose data if required to comply with applicable laws, regulations, or legal processes, or to protect the rights, safety, or property of users or others.

**Business Transfers**: In the event of a merger, acquisition, or sale of assets, telemetry data may be transferred as part of that transaction. We will provide notice if your data becomes subject to a different privacy policy.

**No Sale or Targeted Advertising**: We do not "sell" or "share" personal data for cross-contextual behavioral advertising, and we do not process personal data for "targeted advertising" purposes (as those terms are defined under applicable privacy laws).

## Data Transfers

Desktop Commander processes telemetry data on servers located in various jurisdictions, including the United States. When data is transferred internationally, we apply the protections outlined in this policy regardless of where it is processed, and we only transfer data in accordance with legally valid transfer mechanisms.

## Data Retention

Telemetry data is retained for a period of 14 months, after which it is automatically deleted from Google Analytics. When data is no longer needed, we follow procedures to delete or anonymize it in compliance with applicable laws.

## Security

We implement commercially reasonable technical and organizational measures to protect data from loss, misuse, and unauthorized access. Telemetry data and the default feature-flag request are transmitted via HTTPS. If you override the feature-flag endpoint with `DC_FLAG_URL`, use an `https://` URL to preserve transport encryption. However, no method of transmission over the Internet is completely secure.

## User Control (Opt-Out)

Data collection is **opt-out** — telemetry is enabled by default but you can disable it at any time:

**Option 1: Ask the AI**
Simply ask Claude (or your AI assistant) to disable telemetry:
> "Please disable Desktop Commander telemetryEnabled in config"

**Option 2: Manual configuration**
1. Edit your configuration file at `~/.desktop-commander/config.json`
2. Set `"telemetryEnabled": false`
3. Restart the application

When telemetry is disabled, no telemetry events are sent. Your client ID (UUID) will remain in your config file but won't be used for telemetry unless you re-enable it. The non-telemetry operational network requests described above are separate and are not disabled by this setting.


## Your Rights and Choices

Depending on where you live and the laws that apply, you may have certain rights in relation to your data. These may include the right to access, delete, correct, or transfer your data; to object to or restrict how we process it; or to withdraw consent. You may also have the right to lodge a complaint with your local data protection authority.

**Exercising Your Rights**

The most effective way to stop telemetry collection is to disable telemetry as described above. Once disabled, no further telemetry events will be collected, and any existing telemetry data will be automatically deleted after our 14-month retention period. This does not disable the separate operational network requests described above.

**Why we cannot process UUID-based telemetry requests**: Privacy laws require us to verify the identity of individuals before fulfilling access or deletion requests. Because the telemetry dataset contains no directly identifying information such as email, name, IP address, machine ID, or account, we have no way to verify that someone requesting telemetry data for a particular UUID is actually the person that UUID belongs to. Processing unverifiable requests could inadvertently expose or delete another person's telemetry data.

**What this means for you**:
- The telemetry dataset is designed so the UUID cannot directly identify you
- To stop future telemetry collection: disable telemetry in your config
- To ensure old data is removed: it will automatically purge after 14 months
- If you uninstall Desktop Commander and delete your config file, there is no way to link any stored analytics data back to you

## Privacy Policy Changes

We may update this privacy policy from time to time. When we do, we will publish an updated version and effective date at the top of this page. Your continued use of Desktop Commander after any change constitutes acceptance of the updated policy.

## Contact

- **General questions**: Open an issue on our [GitHub repository](https://github.com/wonderwhy-er/DesktopCommanderMCP)
- **Privacy concerns**: privacy@desktopcommander.app

We aim to respond to privacy inquiries within 30 days.

---

*Desktop Commander is open-source software. This privacy policy primarily covers optional telemetry and also documents the separate operational network requests described above.*
