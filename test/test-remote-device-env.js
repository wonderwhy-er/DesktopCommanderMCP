/**
 * The device (`desktop-commander remote`) starts a local Desktop Commander that
 * runs every tool call. That server must get the device's environment, the
 * same one a Desktop Commander started directly would get: what the user set
 * for the device (a systemd unit's Environment=, a container's env) reaches the
 * tools and the commands they start. Starting it with only the MCP SDK's
 * minimal environment lost, among others, DESKTOP_COMMANDER_DISABLE_TELEMETRY
 * (the device honored it, the server sending the telemetry did not), PATHEXT
 * and ComSpec on Windows, and the container detection variables.
 *
 * Starts the local server through the device's own integration and runs a
 * command that prints a variable set only in the device's environment.
 *
 * The telemetry address the Remote MCP server names (telemetryUrl in
 * /api/mcp-info) reaches the local server the same way, as DC_TELEMETRY_URL,
 * so it has to be in the device's environment before that server starts. A
 * device started against the stand-in (helpers/remote-stand-in.js) is stopped
 * where it starts the local server, and the address must be there by then.
 */
import assert from 'assert';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import { MCPDevice } from '../dist/remote-device/device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { runIfMain } from './helpers/run-if-main.js';

const MARKER = 'DC_TEST_DEVICE_ENV';
const TELEMETRY_URL = 'https://telemetry.example.test/collect';

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function localServerGetsDeviceEnvironment() {
  process.env[MARKER] = 'set-for-the-device';
  const integration = new DesktopCommanderIntegration();
  try {
    await integration.initialize();
    const result = await integration.callClientTool('start_process', {
      command: `node -e "console.log([process.env.${MARKER}, process.env.DC_REMOTE_DEVICE].join('/'))"`,
      timeout_ms: 10000,
    });
    const text = result.content?.[0]?.text ?? '';
    assert(text.includes('set-for-the-device/true'),
      `a command on the device's local server should see the device's ${MARKER} (and DC_REMOTE_DEVICE=true), got:\n${text}`);
    console.log('✓ the local server and its commands get the device\'s environment');
  } finally {
    await integration.shutdown();
    delete process.env[MARKER];
  }
}

async function telemetryAddressBeforeLocalServer() {
  const standIn = await startRemoteStandIn({ telemetryUrl: TELEMETRY_URL });
  const original = { serverUrl: process.env.MCP_SERVER_URL, telemetryUrl: process.env.DC_TELEMETRY_URL };
  process.env.MCP_SERVER_URL = standIn.url;
  try {
    const device = new MCPDevice();
    // Reads the environment the local server would start with, and leaves
    // start() waiting there: nothing after it is under test
    const atLocalServerStart = new Promise((resolve) => {
      device.desktop = {
        initialize: () => {
          resolve(process.env.DC_TELEMETRY_URL);
          return new Promise(() => { });
        },
      };
    });
    void device.start();
    assert.strictEqual(await atLocalServerStart, TELEMETRY_URL,
      'the local server starts with the device\'s environment, so the telemetry address /api/mcp-info names must be in it by then');
    console.log('✓ the telemetry address the server names is in the device\'s environment before the local server starts');
  } finally {
    await standIn.close();
    setEnv('MCP_SERVER_URL', original.serverUrl);
    setEnv('DC_TELEMETRY_URL', original.telemetryUrl);
  }
}

export default async function runTests() {
  await localServerGetsDeviceEnvironment();
  await telemetryAddressBeforeLocalServer();
  return true;
}

runIfMain(import.meta.url, runTests);
