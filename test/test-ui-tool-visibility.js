import assert from 'node:assert/strict';
import { isModelVisibleTool } from '../scripts/model-visible-tools.mjs';
import { runIfMain } from './helpers/run-if-main.js';
export default async function runTests() {
  const entry = (visibility) => ({ name: 'internal', _meta: { ui: { visibility } } });
  assert.equal(isModelVisibleTool({ name: 'read_file' }), true);
  assert.equal(isModelVisibleTool(entry(['model','app'])), true);
  assert.equal(isModelVisibleTool(entry(['model'])), true);
  assert.equal(isModelVisibleTool(entry(['app'])), false);
  assert.equal(isModelVisibleTool(entry([])), false);
  assert.equal(isModelVisibleTool(entry(['unknown'])), false);
  assert.deepEqual([{name:'read_file'},entry(['app']),{name:'edit_block'}].filter(isModelVisibleTool).map(t=>t.name), ['read_file','edit_block']);
  console.log('PASS: model-only tool visibility filter');
  return true;
}
runIfMain(import.meta.url, runTests);
