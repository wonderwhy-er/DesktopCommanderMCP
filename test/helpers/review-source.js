/** A prior Actions unit run as standard --tests input, verified before any model request. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fail = message => { throw new Error(`Review source: ${message}`); };
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function sourceManifest(raw) {
  let input;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) fail('input exceeds 16 KiB.');
  try { input = JSON.parse(raw); } catch { fail('input is not JSON.'); }
  if (!input || input.version !== 1 || !positive(input.run) || !positive(input.attempt) || input.scope !== 'suite' ||
      Object.keys(input).some(key => !['version', 'run', 'attempt', 'scope', 'artifacts'].includes(key)) ||
      !Array.isArray(input.artifacts) || input.artifacts.length < 2 || input.artifacts.length > 6) fail('invalid run/attempt/scope.');
  const names = new Set(), ids = new Set();
  for (const artifact of input.artifacts) {
    const match = /^(results|coverage)-(ubuntu-latest|windows-latest|macos-latest)$/.exec(artifact.name);
    const file = match?.[1] === 'results' ? 'suite/results.json' : 'lcov.info';
    if (!match || !positive(artifact.id) || names.has(artifact.name) || ids.has(artifact.id) ||
        Object.keys(artifact).some(key => !['id', 'name', 'digest', 'file'].includes(key)) ||
        !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) || artifact.file?.path !== file ||
        Object.keys(artifact.file).some(key => !['path', 'sha256'].includes(key)) ||
        !hash(artifact.file?.sha256)) fail('invalid or duplicate artifact identity.');
    names.add(artifact.name); ids.add(artifact.id);
  }
  for (const name of names) {
    const os = name.replace(/^(results|coverage)-/, '');
    if (!names.has(`results-${os}`) || !names.has(`coverage-${os}`)) fail('a selected platform lacks results or coverage.');
  }
  return input;
}

function checkoutHead(log) {
  const matches = [...String(log).matchAll(/\[command\][^\r\n]*\bgit(?:\.exe)?"? log -1 --format=%H\r?\n\S+\s+([0-9a-f]{40})(?=\s*(?:\r?\n|$))/g)];
  if (matches.length !== 1 || !/^\S+\s+TESTS: test\s*$/m.test(log)) fail('unit checkout/TESTS=test evidence is missing or ambiguous.');
  return matches[0][1];
}

function artifactOf(expected, artifacts, run, job) {
  const actual = artifacts.find(artifact => artifact.id === expected.id);
  const created = Date.parse(actual?.created_at);
  const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
  if (!actual || actual.name !== expected.name || actual.digest !== expected.digest || actual.expired !== false ||
      actual.workflow_run?.id !== run.id || actual.workflow_run?.head_sha !== run.head_sha ||
      ![created, start, end].every(Number.isFinite) || start > end || created < start || created > end) {
    fail('artifact run/attempt window, name or digest differs.');
  }
  return { ...expected, createdAt: actual.created_at };
}

export async function verifyPriorRun({ raw, repo, head, base, github }) {
  const input = sourceManifest(raw);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !commit(head) || !commit(base)) fail('invalid repository or frozen range.');
  const api = `/repos/${repo}/actions`;
  const read = async (url, format) => {
    try { return await github('GET', url, null, format); }
    catch { fail('prior Actions evidence could not be read.'); }
  };
  const run = await read(`${api}/runs/${input.run}/attempts/${input.attempt}`);
  if (run.id !== input.run || run.run_attempt !== input.attempt || run.status !== 'completed' ||
      !commit(run.head_sha)) fail('source run attempt is incomplete or differs.');
  const [jobs, artifacts] = await Promise.all([
    read(`${api}/runs/${input.run}/attempts/${input.attempt}/jobs?per_page=100`),
    read(`${api}/runs/${input.run}/artifacts?per_page=100`),
  ]);
  if (jobs.total_count !== jobs.jobs?.length || artifacts.total_count !== artifacts.artifacts?.length) {
    fail('source metadata is incomplete; no truncated page is accepted.');
  }
  const verifiedJobs = [], selected = [];
  const platforms = [...new Set(input.artifacts.map(a => a.name.replace(/^(results|coverage)-/, '')))];
  for (const os of platforms) {
    const job = jobs.jobs.find(j => j.name === `unit (${os})`);
    if (!job || job.run_id !== input.run || job.run_attempt !== input.attempt || job.status !== 'completed') {
      fail('selected unit job does not belong to this completed attempt.');
    }
    const log = await read(`${api}/jobs/${job.id}/logs`, 'text');
    if (typeof log !== 'string' || log.length > 32 * 1024 * 1024) fail('source job log is missing or oversized.');
    if (checkoutHead(log) !== head) fail('actual tested product differs from the requested head.');
    verifiedJobs.push({ id: job.id, platform: os, checkoutHead: head, logSha256: digest(log),
      conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at });
    for (const expected of input.artifacts.filter(a => a.name.endsWith(`-${os}`))) {
      selected.push(artifactOf(expected, artifacts.artifacts, run, job));
    }
  }
  return { version: 1, origin: 'github-actions', repo, run: input.run, attempt: input.attempt, scope: 'suite',
    head, base, workflowHead: run.head_sha, jobs: verifiedJobs, artifacts: selected };
}

function bytesAt(root, name, expected) {
  const resolved = fs.realpathSync(root), file = path.join(resolved, name);
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 16 * 1024 * 1024 ||
      !fs.realpathSync(file).startsWith(`${resolved}${path.sep}`)) fail('artifact path is missing, unsafe or oversized.');
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== expected) fail('downloaded artifact content differs from the pinned source.');
  return bytes;
}

function unitSelection(bytes, platform) {
  let report;
  try { report = JSON.parse(bytes); } catch { fail('unit results are not JSON.'); }
  const files = report.files;
  if (!Array.isArray(files) || !files.length || files.some(f => typeof f.path !== 'string' ||
      !/^test\/[\w./-]+$/.test(f.path) || f.path.split('/').includes('..') || typeof f.success !== 'boolean') ||
      new Set(files.map(f => f.path)).size !== files.length || report.summary?.files !== files.length ||
      report.summary.passed !== files.filter(f => f.success).length ||
      report.summary.failed !== files.filter(f => !f.success).length ||
      !Number.isInteger(report.summary.skippedChecks) || report.summary.skippedChecks < 0 ||
      !Array.isArray(report.excluded)) fail('unit selection/outcome counts differ.');
  return { platform, files: files.map(f => f.path), summary: report.summary, excluded: report.excluded ?? [] };
}

export function stagePriorRun({ checked, downloaded, out }) {
  if (checked.origin !== 'github-actions' || !commit(checked.head) || !commit(checked.base)) fail('missing verified source.');
  const selected = [], files = [];
  for (const artifact of checked.artifacts) {
    const name = `${artifact.name}/${artifact.file.path}`;
    const bytes = bytesAt(downloaded, name, artifact.file.sha256);
    const platform = artifact.name.replace(/^(results|coverage)-/, '');
    if (artifact.name.startsWith('results-')) selected.push(unitSelection(bytes, platform));
    else if (!/^SF:.+/m.test(bytes.toString()) || !/^DA:[1-9]\d*,\d+/m.test(bytes.toString())) fail('LCOV line hits are missing.');
    const target = path.join(out, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes); files.push({ path: name, sha256: artifact.file.sha256 });
  }
  const receipt = { ...checked, selected, files };
  fs.writeFileSync(path.join(out, 'review-source.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function sourceEvidenceOf(folder, { head, base }) {
  const file = path.join(folder, 'review-source.json');
  if (!fs.existsSync(file)) return null;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('source receipt is unreadable.'); }
  if (receipt.origin !== 'github-actions' || receipt.head !== head || receipt.base !== base ||
      !positive(receipt.run) || !positive(receipt.attempt) || !receipt.jobs?.length ||
      receipt.jobs.some(job => job.checkoutHead !== head || !hash(job.logSha256))) fail('source receipt target/proof differs.');
  for (const saved of receipt.files) bytesAt(folder, saved.path, saved.sha256);
  return { selected: receipt.selected.map(({ platform, files }) => ({ platform, files })),
    provenance: { origin: 'github-actions', scope: 'Prior CI unit selection only (TESTS=test); auxiliary repro excluded.',
      productCommit: head, base, workflowHead: receipt.workflowHead,
      attempt: { id: String(receipt.run), number: receipt.attempt }, artifacts: receipt.artifacts,
      jobs: receipt.jobs, summaries: receipt.selected.map(({ platform, summary, excluded }) => ({ platform, summary, excluded })) } };
}
