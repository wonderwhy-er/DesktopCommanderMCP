import assert from 'assert';
import { server } from '../dist/server.js';
import { configManager } from '../dist/config-manager.js';

const SKILL_TOOLS = [
  'list_skills',
  'get_skill',
  'run_skill',
  'get_skill_run',
  'cancel_skill_run',
  'approve_skill_run'
];

function getRequestHandler(method) {
  const handlers = server._requestHandlers;
  assert.ok(handlers, 'Server request handlers should be initialized');
  const handler = handlers.get(method);
  assert.ok(handler, `Expected request handler for ${method}`);
  return handler;
}

async function run() {
  const prevEnabled = await configManager.getValue('skillsEnabled');
  const listToolsHandler = getRequestHandler('tools/list');

  try {
    await configManager.setValue('skillsEnabled', false);
    const hiddenResponse = await listToolsHandler({ method: 'tools/list', params: {} }, {});
    const hiddenTools = hiddenResponse.tools.map((tool) => tool.name);
    for (const skillTool of SKILL_TOOLS) {
      assert.ok(!hiddenTools.includes(skillTool), `${skillTool} should be hidden when disabled`);
    }

    await configManager.setValue('skillsEnabled', true);
    const visibleResponse = await listToolsHandler({ method: 'tools/list', params: {} }, {});
    const visibleTools = visibleResponse.tools.map((tool) => tool.name);
    for (const skillTool of SKILL_TOOLS) {
      assert.ok(visibleTools.includes(skillTool), `${skillTool} should be visible when enabled`);
    }
  } finally {
    await configManager.setValue('skillsEnabled', prevEnabled ?? false);
  }

  console.log('test-skill-tools-visibility: PASS');
}

run().catch((error) => {
  console.error('test-skill-tools-visibility: FAIL', error);
  process.exit(1);
});
