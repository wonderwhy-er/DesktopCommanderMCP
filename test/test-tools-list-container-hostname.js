import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeClient } from './helpers/close-client.js';
import { getOSSpecificGuidance } from '../dist/utils/system-info.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'dist', 'index.js');
const profile = path.join(os.tmpdir(), `dc-issue935-${process.pid}`);
const preload = `data:text/javascript,import os from 'os';os.hostname=()=>process.env.TEST_CONTAINER_HOSTNAME`;

async function listTools(hostname) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', preload, SERVER, '--no-onboarding'],
    cwd: ROOT,
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: profile,
      USERPROFILE: profile,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY ?? '1',
      DC_FLAG_URL: process.env.DC_FLAG_URL ?? 'http://127.0.0.1:9/',
      COMPOSE_PROJECT_NAME: 'issue935',
      TEST_CONTAINER_HOSTNAME: hostname,
    },
  });
  const client = new Client({ name: 'desktop-commander-app', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 30_000 });
    return await client.listTools();
  } finally {
    await closeClient(client);
  }
}

const firstName = 'fd1cb95d1f61';
const secondName = '6f6d4f1f57de';
await fs.mkdir(profile, { recursive: true });
try {
  const first = await listTools(firstName);
  const second = await listTools(secondName);
  const firstByName = new Map(first.tools.map(tool => [tool.name, tool]));
  const secondByName = new Map(second.tools.map(tool => [tool.name, tool]));
  const toolNames = new Set([...firstByName.keys(), ...secondByName.keys()]);
  const changed = [...toolNames].filter(name => JSON.stringify(firstByName.get(name)) !== JSON.stringify(secondByName.get(name)));
  console.log(`CHANGED_TOOLS=${JSON.stringify(changed)}`);
  assert.deepEqual(changed, [], 'tools/list must not change when only the Docker container hostname changes');
  const firstStart = firstByName.get('start_process');
  const secondStart = secondByName.get('start_process');
  assert.ok(firstStart && secondStart, 'start_process must be listed in both runs');
  assert.doesNotMatch(firstStart.description ?? '', new RegExp(firstName), 'first start_process description must not expose container hostname');
  assert.doesNotMatch(secondStart.description ?? '', new RegExp(secondName), 'second start_process description must not expose container hostname');
  assert.match(firstStart.description ?? '', /DOCKER CONTAINER ENVIRONMENT DETECTED/, 'stable Docker guidance should remain');

  const lxcGuidance = getOSSpecificGuidance({
    platformName: 'Linux (LXC)',
    defaultShell: '/bin/sh',
    isWindows: false,
    isMacOS: false,
    docker: {
      isContainer: true,
      containerType: 'lxc',
      orchestrator: null,
      isDocker: false,
      mountPoints: [],
      containerEnvironment: { containerName: 'stable-lxc-name' },
    },
  });
  assert.match(lxcGuidance, /Container: stable-lxc-name/, 'non-Docker container names should remain available');
  console.log('✅ tools/list container-hostname stability test passed');
} finally {
  await fs.rm(profile, { recursive: true, force: true });
}
