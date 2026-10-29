/**
 * #702: on Windows, ssh.exe started through start_process exited 255 and
 * printed nothing. A host built on the MCP SDK starts Desktop Commander with
 * the SDK's default environment unless it passes its own: 12 variables on
 * Windows (getDefaultEnvironment(), SDK 1.32.1), and ProgramData and windir
 * are not among them. ProgramData therefore needs repair for Windows OpenSSH
 * (#702). A Windows host whose own environment already lacks windir can pass
 * that omission through the same path; commands then need windir restored
 * from SystemRoot (#623).
 *
 * Starts the built server as such a host does, with the SDK's default
 * environment, and checks both ways the AI runs its own code:
 * - start_process: Windows OpenSSH's ssh.exe -V must print its version (when
 *   it is installed), and a command must get ProgramData and windir
 * - node:local: the code must get ProgramData and windir
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectToServer, closeClient } from './helpers/mcp-client.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const PROGRAM_DATA = /ProgramData=\[[A-Za-z]:\\ProgramData\]/i;
const WINDOWS_DIRECTORY = /windir=\[[A-Za-z]:\\Windows\]/i;

/** The server as a host on the MCP SDK starts it by default, plus the test run's telemetry and flag switches */
function connectWithDefaultEnvironment() {
  const { DESKTOP_COMMANDER_DISABLE_TELEMETRY, DC_FLAG_URL } = process.env;
  // libuv can add windir from this test runner's own Windows environment when
  // it is merely omitted. An empty value models a host whose launch supplied
  // no usable windir and deterministically exercises Desktop Commander's repair.
  return connectToServer('test-start-process-filtered-env',
    { ...getDefaultEnvironment(), WINDIR: '', DESKTOP_COMMANDER_DISABLE_TELEMETRY, DC_FLAG_URL });
}

/** The text a tool answers with */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result.content?.[0]?.text ?? '';
}

/** start_process can hand a still-running short command back to the caller; collect its remaining output. */
async function runCommand(client, command) {
  let text = await callTool(client, 'start_process', { command, timeout_ms: 10000 });
  const pid = Number(/started with PID (-?\d+)/i.exec(text)?.[1]);
  if (!Number.isInteger(pid) || !/process is running/i.test(text)) return text;

  for (let i = 0; i < 3; i += 1) {
    const more = await callTool(client, 'read_process_output', { pid, offset: 0, timeout_ms: 10000 });
    text += `\n${more}`;
    if (!/process is running/i.test(more)) break;
  }
  return text;
}

export default async function runTests() {
  if (process.platform !== 'win32') {
    return skip('#702/#623: filtered command-environment checks are Windows-only');
  }

  const client = await connectWithDefaultEnvironment();
  try {
    // By its full path: a Git for Windows ssh.exe first on PATH doesn't need ProgramData
    const ssh = path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(ssh)) {
      const version = await runCommand(client, `${ssh} -V`);
      assert(version.includes('OpenSSH_for_Windows'),
        `ssh.exe -V through start_process should print its version, got:\n${version}`);
      console.log('✓ start_process: ssh.exe -V prints its version');
    } else {
      skip(`#702: Windows OpenSSH is not installed (${ssh})`);
    }

    const shown = await runCommand(client, 'cmd.exe /d /c echo ProgramData=[%ProgramData%] windir=[%windir%]');
    assert(PROGRAM_DATA.test(shown), `a command start_process runs should get ProgramData, got:\n${shown}`);
    assert(WINDOWS_DIRECTORY.test(shown), `a command start_process runs should get windir, got:\n${shown}`);
    console.log('✓ start_process: the command gets ProgramData and windir');

    const session = await callTool(client, 'start_process', { command: 'node:local', timeout_ms: 10000 });
    const pid = Number(/started with PID (-?\d+)/.exec(session)?.[1]);
    assert(Number.isInteger(pid), `start_process node:local should start a session, got:\n${session}`);
    const code = "console.log('ProgramData=[' + process.env.ProgramData + '] windir=[' + process.env.windir + ']')";
    const ran = await callTool(client, 'interact_with_process', { pid, input: code, timeout_ms: 10000 });
    assert(PROGRAM_DATA.test(ran), `node:local code should get ProgramData, got:\n${ran}`);
    assert(WINDOWS_DIRECTORY.test(ran), `node:local code should get windir, got:\n${ran}`);
    console.log('✓ node:local: the code gets ProgramData and windir');
  } finally {
    await closeClient(client);
  }
  return true;
}

runIfMain(import.meta.url, runTests);
