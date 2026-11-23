import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { promptOf, textPromptOf } from './helpers/ci-review.js';

for (const [name, templateFile, build] of [
  ['code', 'review-prompt.md', promptOf],
  ['text', 'text-check-prompt.md', textPromptOf],
]) {
  test(`${name} review requires a successful broker source read before answering`, () => {
    const template = fs.readFileSync(new URL(`../.github/${templateFile}`, import.meta.url), 'utf8');
    const prompt = build({ template, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      files: ['source.ts'], title: 'A change', description: '', file: 'claims.md',
      text: 'Adds source.ts.', calls: 8, diff: '+export const value = 1;' });
    assert.match(prompt, /Before answering, use the read-only MCP broker to read source under `pr\/`/);
    assert.match(prompt, /At least one source read must succeed/);
    assert.match(prompt, /inline diff and supplied evidence do not replace that read/);
  });
}
