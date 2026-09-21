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

**Without session persistence** (opt out):
```bash
desktop-commander-device --no-persist-session
```

> **Note**: The device ID and authentication tokens are persisted by default to `~/.desktop-commander-device/device.json` (mode 0600), so the device reconnects without re-authorization. Pass `--no-persist-session` to keep tokens in memory only — the device then requires a full browser re-authorization on every start, and each one leaves a live server-side session behind.

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
*   **Local audit/history logs**: The local MCP server records tool calls on the device. See the main Desktop Commander README for exactly what is stored, log locations, and retention/rotation behavior. The Remote service does not currently retain command arguments/results as a historical server-side audit trail.

---
*Powered by Desktop Commander MCP*

## Internal MQTT transport pilot

The backend keeps Supabase Broadcast and additionally publishes eligible MQTT doorbells.
The connector selects execution locally: `MQTT_EXECUTION_ENABLED` defaults to false
(Broadcast executes); true selects MQTT. Both arrivals remain observable. Disabling
`MQTT_TRANSPORT_ENABLED` disables MQTT entirely and ignores the execution flag.
Keep Supabase authentication, call rows, results and presence running. No database
migration or automatic execution fallback. See [the short transport guide](../../docs/mqtt-broadcast.md).

Build locally with Node 22 (`npm install --ignore-scripts`, then `npm run build`).
Start a connector from this checkout, without publishing or globally linking it:

```bash
DESKTOP_COMMANDER_DISABLE_TELEMETRY=1 \
MCP_SERVER_URL=http://mcp.localhost:3007 \
MCP_DEVICE_CONFIG_PATH=/tmp/dc-mqtt-device-1.json \
MQTT_TRANSPORT_ENABLED=true \
MQTT_EXECUTION_ENABLED=false \
MQTT_ALLOW_INSECURE_LOCAL=true \
node dist/remote-device/device.js
```

Each simultaneously running device needs a separate authenticated device ID/profile.
Use another `MCP_DEVICE_CONFIG_PATH` for another local process; do not copy session
files between people. To keep the team pilot private, use the local Remote MCP
server and test authentication/database setup described in its MQTT pilot guide.
The backend must have AWS enrollment configured. Each connector obtains its own
certificate automatically and connects to the AWS broker returned by the backend.
Teammates on other machines need a reachable HTTPS backend URL.

The MQTT client ID is `dc-device-{deviceId}`. It subscribes at QoS 1 to exactly:

```text
dc/mqtt/v1/users/{authenticatedUserId}/devices/{registeredDeviceId}/new_call
```

Doorbells contain `call_id`, `user_id`, `device_id`, and ISO UTC `expires_at`;
capable connectors also accept `notification_id` and `attempt_number`. The connector
validates identity, topic and size (maximum 1 KiB), records receipt, then checks expiry
and the selected source before fetching the call. It rechecks row ownership, status, and deadline before claiming.
Database claim failure never executes a command. QoS 1 can duplicate a notification;
local in-flight suppression and the conditional database claim prevent duplicate
execution. Admission is capped at 32 concurrent calls per device, including row
fetch, execution, and result reporting. Duplicate notifications are coalesced before
the database fetch. Excess notifications are dropped and their calls time out on the
server; there is no unbounded queue or cross-transport resend. Direct handler calls
have the same concurrency ceiling. Sign-out invalidates admitted calls even when the
same session is subsequently restored. Retained messages are ignored, sessions are clean, and offline replay is
not supported. Commands missed while disconnected are allowed to time out.

`transport_mqtt_v1` is advertised only after a successful QoS 1 subscription. It is
withdrawn on MQTT loss or shutdown and restored after resubscription. Supabase
capabilities are preserved. A failed capability write retries on the existing health
check. `transport_mqtt_observability_v1` additionally signals the extended envelope;
it never advertises execution preference. MQTT start/subscription is bounded to 10 seconds.
Shadow startup failures leave Broadcast execution available; active MQTT startup failures
stop startup. Ordinary post-start network loss reconnects automatically.

### Automatic AWS enrollment prototype

After the internal backend's AWS enrollment configuration is ready, each tester only
needs the new connector, their own normal login/profile, and these process settings:

```bash
MCP_SERVER_URL=https://YOUR_INTERNAL_BACKEND \
MCP_DEVICE_CONFIG_PATH=/absolute/path/to/device.json \
MQTT_TRANSPORT_ENABLED=true \
node dist/remote-device/device.js
```

The connector generates an RSA private key locally, sends only a signed CSR and its
registered device ID to `POST /device/mqtt/enroll` with the current authentication
token, and receives the certificate and broker URL. No device AWS keys, manually
downloaded certificates, or broker URL are needed. The server publisher still needs
its own credentials. This requires a backend that supports this enrollment route;
testers must be able to reach it and AWS MQTT on outbound port 8883.

Credentials are saved beside the profile in `<profile-path>.mqtt/identity.json`
and `certificate.json`, with private directory/file permissions. The identity file
contains the **private key**; never share, log, or commit it. Successful enrollment
is reused on restart and bound to the backend origin, authenticated user and device.
Use a separate profile for each device/account/backend, and only one process per
profile. Invalid, expired or mismatched cached credentials are never silently replaced;
MQTT stays unavailable (active MQTT startup fails; shadow mode keeps Broadcast).

Enrollment makes one request with a 30-second timeout and **no retries or automatic
renewal**. Fix the reported configuration/access/network problem and restart manually.
An interrupted attempt may leave an AWS certificate requiring manual cleanup. Keep
the identity file to reuse its key after a failed request; do not delete an existing
successful cache without first accounting for its AWS certificate. Pilot removal
requires manual AWS certificate deactivation and disconnection.

HTTPS is required except for explicit local tests: set
`MQTT_ALLOW_INSECURE_LOCAL=true` with `http://mcp.localhost:3007` (or localhost/loopback).
That flag does not disable TLS verification for the AWS broker. A custom test broker
CA can still be supplied through `MQTT_CA_FILE`. HTTP redirects are rejected.

Enabling `MQTT_TRANSPORT_ENABLED=true` always uses automatic enrollment or its saved
certificate cache. The old `MQTT_ENROLLMENT_ENABLED` variable is ignored, including
when set to `false`. Manually supplied device certificates are not a connector startup
mode. The server publisher still uses its separately configured certificate.

`.env.example` contains blank templates, not an automatically loaded configuration.
No new cloud-global flags are needed. MQTT variables belong only to the connector
process; server-side rollout variables are documented in the Remote MCP repository.
Run `npm run build` then `npm run test:mqtt` for the local receiver test lane.
