/**
 * A workflow file's text, read the way the CI tests check it (test-ci-platforms.js):
 * a job's lines, and the lines under one of its keys.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { ROOT } from './node-test-runner.js';

/** A workflow in .github/workflows, its lines as LF whatever the checkout's line ends */
export const readWorkflow = (file) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8').replace(/\r\n/g, '\n');

/** The lines of a job in the workflow file, from `  <job>:` to the next job */
export function jobLines(workflow, job) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${job}:`);
  assert.ok(start >= 0, `the workflow has a job ${job}`);
  const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** The lines indented under a key of a job, e.g. its `permissions:` */
export function blockUnder(jobLinesList, key) {
  const from = jobLinesList.indexOf(`    ${key}:`);
  assert.ok(from > 0, `the job has ${key}`);
  const block = [];
  for (const line of jobLinesList.slice(from + 1)) {
    if (!line.startsWith('      ')) break;
    block.push(line.trim());
  }
  return block;
}
