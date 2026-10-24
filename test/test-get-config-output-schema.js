/**
 * #689 pilot: get_config advertises a real, checkable MCP outputSchema.
 * The existing human-readable content and structuredContent stay intact.
 */
import assert from 'node:assert/strict';
import { connectToServer, closeClient } from './helpers/mcp-client.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const client = await connectToServer('get-config-output-schema-regression');
  try {
    const { tools } = await client.listTools();
    const getConfig = tools.find((tool) => tool.name === 'get_config');
    assert.ok(getConfig, 'get_config must be exposed');
    assert.ok(getConfig.outputSchema, 'get_config needs an MCP outputSchema');
    const advertised = getConfig.outputSchema;
    assert.equal(advertised.type, 'object');
    assert.deepEqual([...advertised.required].sort(), ['config', 'entries', 'uiHints'].sort());
    assert.equal(advertised.properties.uiHints.properties.availableShells.items.type, 'string');
    assert.ok(advertised.properties.entries.items.properties.key.enum.includes('defaultShell'));
    assert.equal(advertised.properties.entries.items.properties.editable.const, true);
    // A sparse config yields an entry with value: undefined, omitted over JSON.
    // The published JSON schema must accept the serialized form.
    const sparseEntry = JSON.parse(JSON.stringify({
      key: 'defaultShell', value: undefined, valueType: 'string', editable: true,
    }));
    assert.equal(Object.hasOwn(sparseEntry, 'value'), false);
    assert.ok(!advertised.properties.entries.items.required.includes('value'),
      'get_config output schema must not require values omitted by JSON serialization');

    const result = await client.callTool({ name: 'get_config', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.match(result.content?.[0]?.text ?? '', /^Current configuration:\n/);
    assert.ok(result.structuredContent, 'get_config must preserve its existing structuredContent');

    const { GetConfigOutputSchema } = await import('../dist/tools/output-schemas.js');
    assert.equal(GetConfigOutputSchema.safeParse({
      ...result.structuredContent,
      entries: [sparseEntry],
    }).success, true, 'serialized sparse config entries must validate without a value property');
    assert.equal(GetConfigOutputSchema.safeParse(result.structuredContent).success, true,
      'actual structured result must conform to its declared output schema');
    assert.equal(GetConfigOutputSchema.safeParse({
      ...result.structuredContent,
      uiHints: { availableShells: 12 },
    }).success, false, 'invalid shell list must not satisfy the contract');
    assert.equal(GetConfigOutputSchema.safeParse({
      ...result.structuredContent,
      entries: [{ key: 'notAnEditableConfigField', value: 10, valueType: 'number', editable: true }],
    }).success, false, 'unknown config keys must not satisfy the contract');
    assert.deepEqual(result.structuredContent.entries.map((entry) => entry.key).sort(),
      ['allowedDirectories','blockedCommands','defaultShell','fileReadLineLimit','fileWriteLineLimit','telemetryEnabled'].sort());
    console.log('ok - get_config publishes outputSchema and preserves its existing client response');
    console.log('ok - output contract rejects malformed shell hints and unknown editable config keys');
    return true;
  } finally {
    await closeClient(client);
  }
}
runIfMain(import.meta.url, runTests);
