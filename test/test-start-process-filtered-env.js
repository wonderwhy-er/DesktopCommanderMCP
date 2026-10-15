/**
 * #702: on Windows, ssh.exe started through start_process exited 255 and
 * printed nothing. A host built on the MCP SDK starts Desktop Commander with
 * the SDK's default environment unless it passes its own: 12 variables on
 * Windows (getDefaultEnvironment(), SDK 1.32.1), and ProgramData is not one of
 * them. What the AI runs (start_process commands, node:local code) gets the
 * server's own environment, so it has no ProgramData either, and Windows
 * OpenSSH (ssh, scp, sftp, ssh-keygen) then exits 255 before it writes a byte.
 *
 * Starts the built server as such a host does, with the SDK's default
 * environment, and checks both ways the AI runs its own code:
 * - start_process: Windows OpenSSH's ssh.exe -V must print its version (when
 *   it is installed), and a command must get ProgramData
 * - node:local: the code must get ProgramData
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectToServer, closeClient } from './helpers/mcp-client.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const PROGRAM_DATA = /ProgramData=\[[A-Za-z]:\\ProgramData\]/i;

/** The server as a host on the MCP SDK starts it by default, plus the test run's telemetry and flag switches */
function connectWithDefaultEnvironment() {
  const { DESKTOP_COMMANDER_DISABLE_TELEMETRY, DC_FLAG_URL } = process.env;
  return connectToServer('test-start-process-filtered-env',
    { ...getDefaultEnvironment(), DESKTOP_COMMANDER_DISABLE_TELEMETRY, DC_FLAG_URL });
}

/** The text a tool answers with */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result.content?.[0]?.text ?? '';
}

export default async function runTests() {
  if (process.platform !== 'win32') {
    return skip('#702: ProgramData and Windows OpenSSH are Windows-only');
  }

  const client = await connectWithDefaultEnvironment();
  try {
    // By its full path: a Git for Windows ssh.exe first on PATH doesn't need ProgramData
    const ssh = path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(ssh)) {
      const version = await callTool(client, 'start_process', { command: `${ssh} -V`, timeout_ms: 10000 });
      assert(version.includes('OpenSSH_for_Windows'),
        `ssh.exe -V through start_process should print its version, got:\n${version}`);
      console.log('✓ start_process: ssh.exe -V prints its version');
    } else {
      skip(`#702: Windows OpenSSH is not installed (${ssh})`);
    }

    const shown = await callTool(client, 'start_process', { command: 'cmd.exe /d /c echo ProgramData=[%ProgramData%]', timeout_ms: 10000 });
    assert(PROGRAM_DATA.test(shown), `a command start_process runs should get ProgramData, got:\n${shown}`);
    console.log('✓ start_process: the command gets ProgramData');

    const session = await callTool(client, 'start_process', { command: 'node:local', timeout_ms: 10000 });
    const pid = Number(/started with PID (-?\d+)/.exec(session)?.[1]);
    assert(Number.isInteger(pid), `start_process node:local should start a session, got:\n${session}`);
    const code = "console.log('ProgramData=[' + process.env.ProgramData + ']')";
    const ran = await callTool(client, 'interact_with_process', { pid, input: code, timeout_ms: 10000 });
    assert(PROGRAM_DATA.test(ran), `node:local code should get ProgramData, got:\n${ran}`);
    console.log('✓ node:local: the code gets ProgramData');
  } finally {
    await closeClient(client);
  }
  return true;
}

runIfMain(import.meta.url, runTests);
