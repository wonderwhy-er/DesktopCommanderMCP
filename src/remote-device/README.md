# Desktop Commander Remote Device

The **Desktop Commander Remote Device** is a lightweight connector that allows your local computer to be controlled safely and securely by remote AI Remote MCPs, such as:
*   **ChatGPT** (via Connectors)
*   **Claude** (via Connectors)
*   **Other LLM interfaces**

It acts as a secure bridge between the remote AI and your local Desktop Commander MCP server, enabling the AI to execute terminal commands, edit files, and manage your system just as if it were running locally on your machine.

## 🚀 How It Works

1.  **Local MCP Server**: You run the standard Desktop Commander MCP server on your machine (globally or locally).
2.  **Remote Device**: You run this device, which connects to the **Desktop Commander Remote MCP** (hosted in the cloud).
3.  **Secure Tunnel**: The device maintains a secure WebSocket connection to the Remote MCP.
4.  **AI Control**: The remote AI sends tool calls (like "read file" or "run command") to the Remote MCP, which forwards them to your device.
5.  **Execution**: Your device executes the command via your local MCP server and sends the result back.

## 📋 Prerequisites

Before running the device, ensure you have:

1.  **Node.js**: Version 18 or higher installed.
2.  **Desktop Commander MCP Server**: Installed and capable of running.
    *   **Global Install (Recommended)**:
        ```bash
        npm install -g @wonderwhy-er/desktop-commander
        ```
    *   **Local Build**: If you are developing locally, the device can also find the server in `../../dist/index.js`.

## 🛠️ Installation

### Option 1: Global Installation (Recommended)

Install the module globally to run it from anywhere:

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/wonderwhy-er/DesktopCommanderMCP.git
    cd DesktopCommanderMCP/src/remote-device
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

3.  **Install Globally**:
    ```bash
    npm install -g .
    ```
    
    Or for development (creates a symlink):
    ```bash
    npm link
    ```

4.  **Run from anywhere**:
    ```bash
    desktop-commander-device
    ```

### Option 2: Local Installation

Run from the project repository without global installation:

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/wonderwhy-er/DesktopCommanderMCP.git
    cd DesktopCommanderMCP
    ```

2.  **Install Dependencies**:
    Navigate to the root directory and install the required packages:
    ```bash
    npm run device:install
    ```

## 🚦 Usage

### 1. Start the Device

**If installed globally**:
```bash
desktop-commander-device
```

**With session persistence** (optional):
```bash
desktop-commander-device --persist-session
```

> **Note**: By default, only the device ID is persisted. Use `--persist-session` to also save authentication tokens between restarts. This allows the device to reconnect automatically without re-authentication.

**If using local installation** from the project root directory:

```bash
npm run device:start
```

*(Or direct from `src/remote-device`: `npm run device`)*

### 2. Authenticate

On first run, the device uses the **OAuth 2.0 Device Authorization Flow** for secure authentication:

1. **Request Device Code**: The device requests a unique verification code from the server.
2. **User Verification**: 
   - A browser window will automatically open to the verification page
   - If the browser doesn't open, you'll see a URL to visit manually
   - Enter the displayed code when prompted (e.g., `BLPU-9E9R`)
3. **Authorization**: Sign in with your account and authorize the device
4. **Automatic Connection**: The device polls the server and automatically connects once you've authorized

**Example Output**:
```
🔐 Starting device authorization flow...
   - 📡 Requesting device code...
   - ✅ Device code received

📋 Please complete authentication:
   1. Open this URL in your browser:
      https://test.acidpictures.org/device/verify
   2. Enter this code when prompted:
      BLPU-9E9R
   Code expires in 15 minutes.
   - ⏳ Waiting for authorization...
   - ✅ Authorization successful!
```

> **Note**: This flow works in all environments (desktop, server, container) without requiring a local callback server. The device simply polls the server until you complete authentication in your browser.

### 3. Connect your AI

Once the device is running and authenticated:
1.  Navigate to **[https://mcp.desktopcommander.app](https://mcp.desktopcommander.app)**.
2.  Use the interface to connect to the **Remote MCP** using available connectors.
3.  Authorize the connection when prompted.
4.  Your AI (ChatGPT/Claude) will now be able to see your connected device and execute commands!

## 🔧 Development & Debugging

For developers contributing to the device or debugging issues:

**Run with Debug Logging**:
```bash
npm run device:dev
```
This enables verbose logging and ensures the device picks up usage of a local MCP server build if available.


## 🔒 Security

*   **You are in control**: The device runs on *your* machine. You can stop it at any time (`Ctrl+C`) to cut off access.
*   **Local Execution**: Commands are executed locally under your user permissions.
*   **Audit Logs**: The local MCP server logs all actions (see the main Desktop Commander README for log locations).

---
*Powered by Desktop Commander MCP*
