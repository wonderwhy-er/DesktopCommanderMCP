/**
 * The search-memory repro judges its `many` scenario by ripgrep's peak memory,
 * sampled while ripgrep runs. A ripgrep that starts and exits between two
 * samples is never seen, and its peak reads 0, which measures nothing. As a
 * skipped check is, `many` is then named as not measured, never counted as
 * bounded, and doesn't fail the run by itself. Here the sampling interval is a
 * minute: the server is sampled once before the search, and the search's
 * ripgrep is certain to be missed.
 */
import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { runNode } from './helpers/run-node.js';
import { runIfMain } from './helpers/run-if-main.js';

const REPRO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'repro', 'test-search-memory.js');
const VERDICT = /^(REPRODUCED|NOT REPRODUCED|NOT MEASURED|SKIPPED):/;

export default async function runTests() {
  const result = await runNode([REPRO], {
    env: { ...process.env, REPRO_MB: '1', REPRO_SCENARIOS: 'many', REPRO_SAMPLE_MS: '60000' },
    timeoutMs: 120_000,
  });
  const lines = `${result.stdout}${result.stderr}`.split(/\r?\n/);
  const verdicts = lines.filter((line) => VERDICT.test(line));
  const report = lines.filter((line) => /ripgrep peak|memory not measured|error/i.test(line) || VERDICT.test(line)).join(' | ');
  try {
    assert.strictEqual(result.status, 0, `a many search whose ripgrep exited between samples should not fail the run by itself, got exit ${result.status}: ${report}`);
    assert(lines.some((line) => line.includes('ripgrep peak not measured: ripgrep exited between samples')),
      `the many line should say ripgrep was not measured: ${report}`);
    assert(verdicts.length === 1 && verdicts[0].includes('not measured: many (ripgrep exited between samples)'),
      `the verdict line should name many as not measured: ${report}`);
    assert(!verdicts.some((line) => /^(NOT REPRODUCED|REPRODUCED|NOT MEASURED):/.test(line)),
      `the verdict should neither claim many stayed bounded nor count it as a finding or a sampling failure: ${report}`);
    console.log(`✓ a many search whose ripgrep exited between samples is named as not measured, not bounded, and the run exits 0 ("${verdicts[0]}")`);
    return true;
  } catch (error) {
    console.log(`✗ ${error.message}`);
    return false;
  }
}

runIfMain(import.meta.url, runTests);
