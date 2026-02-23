import assert from 'assert';
import { server } from '../dist/server.js';
import { configManager } from '../dist/config-manager.js';

const SKILLS_CATALOG_URI = 'dc://skills/catalog';
const SKILLS_EVAL_GATE_URI = 'dc://skills/eval-gate';
const SKILL_RUN_UNKNOWN_URI = 'dc://skills/runs/skill_run_unknown_0';

function getRequestHandler(method) {
  const handlers = server._requestHandlers;
  assert.ok(handlers, 'Server request handlers should be initialized');
  const handler = handlers.get(method);
  assert.ok(handler, `Expected request handler for ${method}`);
  return handler;
}

function parseResourceText(result) {
  assert.ok(result && result.contents && result.contents.length > 0, 'Expected resource contents');
  const text = result.contents[0].text;
  assert.ok(typeof text === 'string' && text.length > 0, 'Expected text payload');
  return JSON.parse(text);
}

async function run() {
  const prevEnabled = await configManager.getValue('skillsEnabled');
  const listResourcesHandler = getRequestHandler('resources/list');
  const listTemplatesHandler = getRequestHandler('resources/templates/list');
  const readResourceHandler = getRequestHandler('resources/read');

  try {
    await configManager.setValue('skillsEnabled', false);

    const listResult = await listResourcesHandler({ method: 'resources/list', params: {} }, {});
    const uris = new Set(listResult.resources.map((r) => r.uri));
    assert.ok(uris.has(SKILLS_CATALOG_URI), 'Expected skills catalog resource to be listed');
    assert.ok(uris.has(SKILLS_EVAL_GATE_URI), 'Expected eval gate resource to be listed');

    const templates = await listTemplatesHandler({ method: 'resources/templates/list', params: {} }, {});
    assert.ok(Array.isArray(templates.resourceTemplates), 'Expected resourceTemplates array');
    const templateUris = templates.resourceTemplates.map((t) => t.uriTemplate);
    assert.ok(templateUris.includes('dc://skills/runs/{runId}'), 'Expected run resource template');

    const catalogDisabled = parseResourceText(
      await readResourceHandler({ method: 'resources/read', params: { uri: SKILLS_CATALOG_URI } }, {})
    );
    assert.equal(catalogDisabled.enabled, false, 'Catalog should report enabled=false when skills disabled');

    const gateDisabled = parseResourceText(
      await readResourceHandler({ method: 'resources/read', params: { uri: SKILLS_EVAL_GATE_URI } }, {})
    );
    assert.equal(gateDisabled.enabled, false, 'Eval gate should report enabled=false when skills disabled');
    assert.ok(gateDisabled.schemaVersion === 1, 'Expected schemaVersion=1');

    const unknownRun = parseResourceText(
      await readResourceHandler({ method: 'resources/read', params: { uri: SKILL_RUN_UNKNOWN_URI } }, {})
    );
    assert.equal(unknownRun.found, false, 'Unknown run should report found=false');
    assert.equal(unknownRun.reasonCode, 'run_not_found', 'Unknown run should return reasonCode=run_not_found');

    await configManager.setValue('skillsEnabled', true);
    const catalogEnabled = parseResourceText(
      await readResourceHandler({ method: 'resources/read', params: { uri: SKILLS_CATALOG_URI } }, {})
    );
    assert.equal(catalogEnabled.enabled, true, 'Catalog should report enabled=true when skills enabled');
    assert.ok(typeof catalogEnabled.total === 'number', 'Catalog should include total');
    assert.ok(Array.isArray(catalogEnabled.skills), 'Catalog should include skills array');
  } finally {
    await configManager.setValue('skillsEnabled', prevEnabled ?? false);
  }

  console.log('test-skill-resources: PASS');
}

run().catch((error) => {
  console.error('test-skill-resources: FAIL', error);
  process.exit(1);
});

