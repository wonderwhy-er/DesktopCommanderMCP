/**
 * #692: a config.json saved as "UTF-8 with BOM" (Notepad, PowerShell 5's
 * `Set-Content -Encoding UTF8`) still holds the user's whole config. Read as
 * text, it starts with an invisible U+FEFF that JSON.parse rejects, so every
 * start failed with `MCP error -32603: Unexpected token '﻿', "﻿{…"... is not
 * valid JSON`. Desktop Commander must read it as the config it is: start, and
 * apply the user's own settings, not treat the file as damaged.
 *
 * Starts the real server over stdio (dist/index.js) the way `remote` does.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createTestEnv } from './helpers/test-env.js';
import { startServerLikeRemote } from './helpers/mcp-server.js';
import { runIfMain } from './helpers/run-if-main.js';

async function run() {
  const { env, home, cleanup } = createTestEnv();
  const configDir = path.join(home, '.claude-server-commander');
  const configPath = path.join(configDir, 'config.json');
  const projects = path.join(home, 'projects');
  const saved = {
    blockedCommands: ['rm'],
    allowedDirectories: [projects],
    telemetryEnabled: false,
    clientId: 'bom-test',
    pendingWelcomeOnboarding: false,
    welcomeOnboardingEligible: false,
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(saved, null, 2))]));

  const failures = [];
  const check = async (name, test) => {
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`✗ ${name}\n  ${error.message}`);
    }
  };

  let server;
  try {
    await check('a config saved with a BOM does not stop the server from starting', async () => {
      try {
        server = await startServerLikeRemote(env);
      } catch (error) {
        assert.fail(`with config.json saved as UTF-8 with BOM, the start failed: ${error.message}`);
      }
    });

    await check("the user's own settings from the BOM file are in effect", async () => {
      assert(server, 'the server did not start');
      const result = await server.client.callTool({ name: 'get_config', arguments: {} });
      const config = result.structuredContent?.config ?? {};
      for (const key of ['blockedCommands', 'allowedDirectories', 'telemetryEnabled', 'clientId']) {
        assert.deepStrictEqual(config[key], saved[key], `with config.json saved as UTF-8 with BOM, ${key} is ${JSON.stringify(config[key])} instead of the user's ${JSON.stringify(saved[key])}`);
      }
    });

    await check('the BOM file is not treated as damaged, and the next write keeps its settings', async () => {
      assert(server, 'the server did not start');
      const result = await server.client.callTool({ name: 'set_config_value', arguments: { key: 'fileReadLineLimit', value: 500 } });
      assert.notStrictEqual(result.isError, true, `set_config_value failed: ${result.content?.[0]?.text}`);
      // Anything beside config.json but its lock and a write's temp file
      const others = fs.readdirSync(configDir)
        .filter((name) => name.startsWith('config.json.') && !name.endsWith('.lock') && !name.endsWith('.tmp'));
      assert.deepStrictEqual(others, [], `a config saved with a BOM was handled as damaged: ${others.join(', ')}`);
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(onDisk.fileReadLineLimit, 500, 'the write must land');
      for (const key of ['blockedCommands', 'allowedDirectories', 'telemetryEnabled', 'clientId']) {
        assert.deepStrictEqual(onDisk[key], saved[key], `after a write, config.json has ${key} ${JSON.stringify(onDisk[key])} instead of the user's ${JSON.stringify(saved[key])}`);
      }
    });
  } finally {
    await server?.close();
    cleanup();
  }

  if (failures.length > 0) {
    console.log(`${failures.length} of 3 cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
