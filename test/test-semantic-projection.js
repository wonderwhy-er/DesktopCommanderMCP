import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-semantic-projection-'));
process.env.HOME = tempHome;
process.env.TYPESAFE_API_KEY = 'test-typesafe-key-not-real';

const originalFetch = globalThis.fetch;

try {
  const { configManager } = await import('../dist/config-manager.js');
  const { selectRelevantLineChunks, selectRelevantCandidates } =
    await import('../dist/semantic-projection/select.js');

  await configManager.setValue('semanticProjectionEnabled', true);
  await configManager.setValue('semanticProjectionModel', 'jev-latest');

  let lastRequest;
  globalThis.fetch = async (_url, init) => {
    lastRequest = JSON.parse(String(init.body));
    const answers = {};
    for (const [id, question] of Object.entries(lastRequest.questions ?? {})) {
      const match = String(question.instructions).match(/(?:chunks|candidates)\[(\d+)\]/);
      const index = Number(match?.[1] ?? 0);
      const source = lastRequest.state.chunks?.[index]?.text
        ?? lastRequest.state.candidates?.[index]?.text
        ?? '';
      answers[id] = { type: 'noul', noul: source.includes('NEEDLE') ? 0.97 : 0.08 };
    }
    return new Response(JSON.stringify({ model: 'jev-latest', answers, usage: { input_tokens: 1000, output_tokens: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const text = [
    'ordinary line 1',
    'ordinary line 2',
    'ordinary line 3',
    'ordinary line 4',
    'ordinary line 5',
    'NEEDLE root cause appears here',
    'important follow-up',
    'ordinary tail',
  ].join('\n');

  const projected = await selectRelevantLineChunks(text, {
    mode: 'select',
    instruction: 'Find the root cause',
    chunkLines: 5,
    limit: 1,
  });

  assert.equal(projected.selected.length, 1);
  assert.match(projected.selected[0].text, /NEEDLE/);
  assert.equal(projected.selected[0].startLine, 5);
  assert.equal(projected.selected[0].score, 0.97);
  assert.equal(lastRequest.model, 'jev-latest');
  assert.match(JSON.stringify(lastRequest.state), /NEEDLE/);
  assert.equal(projected.metrics.jev.inputTokens, 1000);
  assert.equal(projected.metrics.jev.outputTokens, 0);
  assert.equal(projected.metrics.jev.estimatedCostUsd, 0.000042);
  assert.ok(projected.metrics.jev.requestBytes > 0);
  assert.ok(projected.metrics.jev.responseBytes > 0);
  assert.ok(projected.metrics.jev.latencyMs >= 0);
  assert.ok(projected.metrics.withheldPercent > 0);
  assert.equal(projected.metrics.source.lines, 8);
  assert.equal(projected.metrics.exposedToHost.lines, 3);

  const candidateProjection = await selectRelevantCandidates([
    { id: 'a', label: 'a.ts', text: 'ordinary implementation' },
    { id: 'b', label: 'b.ts', text: 'NEEDLE relevant implementation' },
  ], {
    mode: 'select',
    instruction: 'Find relevant implementation',
    limit: 1,
  });

  assert.equal(candidateProjection.selected.length, 1);
  assert.equal(candidateProjection.selected[0].id, 'b');
  assert.equal(candidateProjection.selected[0].score, 0.97);
  assert.equal(candidateProjection.metrics.exposedToHost.bytes, 0);
  assert.equal(candidateProjection.metrics.withheldPercent, 100);
  assert.equal(candidateProjection.metrics.jev.inputTokens, 1000);

  console.log('✅ Semantic projection selection tests passed');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(tempHome, { recursive: true, force: true });
}
