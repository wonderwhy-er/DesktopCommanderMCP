/** A prior Actions selection as standard --tests input, verified before any model request. */
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
  if (!input || input.version !== 1 || !positive(input.run) || !positive(input.attempt) ||
      typeof input.scope !== 'string' || input.scope.length > 4096 ||
      !(['suite', 'ci-default', 'test', 'integration', 'repro', 'docker', 'timed'].includes(input.scope) ||
        /^(files|changed):/.test(input.scope)) ||
      Object.keys(input).some(key => !['version', 'run', 'attempt', 'scope', 'artifacts'].includes(key)) ||
      !Array.isArray(input.artifacts) || input.artifacts.length < 2 || input.artifacts.length > 18) fail('invalid run/attempt/scope.');
  const names = new Map(), ids = new Map(), files = new Set();
  for (const artifact of input.artifacts) {
    const match = /^(results|coverage)-(ubuntu-latest|windows-latest|macos-latest)$/.exec(artifact.name);
    const file = artifact.file?.path;
    let validFile = file === 'lcov.info';
    if (match?.[1] === 'results') {
      validFile = input.scope === 'suite' ? file === 'suite/results.json' : /^[a-z][a-z-]*\/results.json$/.test(file);
    }
    const identity = `${artifact.name}:${artifact.digest}`;
    if (!match || !positive(artifact.id) || !validFile || files.has(`${artifact.id}:${file}`) ||
        (names.has(artifact.name) && names.get(artifact.name) !== artifact.id) ||
        (ids.has(artifact.id) && ids.get(artifact.id) !== identity) ||
        Object.keys(artifact).some(key => !['id', 'name', 'digest', 'file'].includes(key)) ||
        !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
        Object.keys(artifact.file).some(key => !['path', 'sha256'].includes(key)) ||
        !hash(artifact.file?.sha256)) fail('invalid or duplicate artifact identity.');
    names.set(artifact.name, artifact.id); ids.set(artifact.id, identity); files.add(`${artifact.id}:${file}`);
  }
  for (const name of names.keys()) {
    const os = name.replace(/^(results|coverage)-/, '');
    if (!names.has(`results-${os}`) || !names.has(`coverage-${os}`)) fail('a selected platform lacks results or coverage.');
  }
  return input;
}

function checkoutHead(log) {
  const matches = [...String(log).matchAll(/\[command\][^\r\n]*\bgit(?:\.exe)?"? log -1 --format=%H\r?\n\S+\s+([0-9a-f]{40})(?=\s*(?:\r?\n|$))/g)];
  if (matches.length !== 1) fail('checkout evidence is missing or ambiguous.');
  return matches[0][1];
}

async function sourceIdentity({ tested, head, base, run, log, read, repo }) {
  if (tested === head) return { mode: 'exact', requestedHead: head, testedHead: tested };
  if (run.event !== 'pull_request' || run.head_sha !== head || !run.pull_requests?.some(pr =>
    positive(pr.number) && log.includes(`refs/remotes/pull/${pr.number}/merge`))) fail('unproved PR merge checkout.');
  const api = `/repos/${repo}/git/commits/`;
  const [merged, requested, reviewBase] = await Promise.all([read(api + tested), read(api + head), read(api + base)]);
  const parents = merged.parents?.map(parent => parent.sha) ?? [];
  const testBase = parents.find(parent => parent !== head);
  if (merged.sha !== tested || requested.sha !== head || reviewBase.sha !== base ||
      parents.length !== 2 || !parents.includes(head) || !commit(merged.tree?.sha) ||
      merged.tree.sha !== requested.tree?.sha || !(testBase === base ||
        reviewBase.parents?.some(parent => parent.sha === testBase))) fail('PR merge tree or trusted parents differ.');
  return { mode: 'verified-merge-tree', requestedHead: head, testedHead: tested, tree: merged.tree.sha,
    parents, testedBase: testBase, reviewBase: base, reviewBaseParents: reviewBase.parents.map(parent => parent.sha) };
}

async function sourceSelection({ scope, log, tested, os, input, read, repo }) {
  const values = [...log.matchAll(/^\S+\s+TESTS:[ \t]*(.*)$/gm)].map(([, value]) => value.trim());
  if (values.length !== 1) fail('actual TESTS selection is missing or ambiguous.');
  if ([...log.matchAll(/^\S+\s+TESTS_FROM:[ \t]*(.*)$/gm)].some(([, value]) => value.trim())) {
    fail('tests_from overlay needs separate immutable producer-commit evidence.');
  }
  if (scope === 'suite') {
    if (values[0] !== 'test') fail('suite scope requires actual TESTS=test.');
    return { tests: 'test', parts: ['suite'] };
  }
  const wanted = scope === 'ci-default' ? '' : scope;
  if (values[0] !== wanted || !log.includes('##[group]Run npm run test:coverage')) fail('CI command/actual TESTS differs.');
  let source;
  try { source = await read(`/repos/${repo}/contents/test/run-ci.js?ref=${tested}`); }
  catch { fail('test/run-ci.js producer evidence at the tested commit is unavailable.'); }
  const trusted = fs.readFileSync(new URL('../run-ci.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(trusted)}\0${trusted}`).digest('hex');
  if (source.sha !== blob) fail('default CI producer differs from the trusted harness.');
  const { planFor } = await import('../run-ci.js');
  const platform = { 'ubuntu-latest': 'linux', 'windows-latest': 'win32', 'macos-latest': 'darwin' }[os];
  let plan;
  try { plan = planFor(wanted, { underCoverage: true, env: { GITHUB_ACTIONS: 'true' }, platform }); }
  catch { fail('actual TESTS selector is unsupported by the trusted producer.'); }
  if (plan.some(part => !log.includes(`########## ${part.name} ##########`))) fail('producer execution manifest is incomplete.');
  const parts = plan.filter(part => part.report).map(part => path.basename(path.dirname(part.report)));
  const supplied = input.artifacts.filter(a => a.name === `results-${os}`).map(a => a.file.path);
  if (supplied.length !== parts.length || parts.some(part => !supplied.includes(`${part}/results.json`))) {
    fail('artifact part scope differs from the actual producer manifest.');
  }
  return { command: 'npm run test:coverage', tests: wanted, blob, parts };
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
  const cache = new Map();
  const read = (url, format) => {
    const key = `${format ?? 'json'}:${url}`;
    if (!cache.has(key)) cache.set(key, github('GET', url, null, format)
      .catch(() => { fail('prior Actions evidence could not be read.'); }));
    return cache.get(key);
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
    const tested = checkoutHead(log);
    const identity = await sourceIdentity({ tested, head, base, run, log, read, repo });
    const producer = await sourceSelection({ scope: input.scope, log, tested, os, input, read, repo });
    verifiedJobs.push({ id: job.id, platform: os, checkoutHead: tested, sourceIdentity: identity, producer,
      logSha256: digest(log),
      conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at });
    for (const expected of input.artifacts.filter(a => a.name.endsWith(`-${os}`))) {
      selected.push(artifactOf(expected, artifacts.artifacts, run, job));
    }
  }
  return { version: 1, origin: 'github-actions', repo, run: input.run, attempt: input.attempt, scope: input.scope,
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

function reportSelection(bytes, { platform, part, allowEmpty }) {
  let report;
  try { report = JSON.parse(bytes); } catch { fail('unit results are not JSON.'); }
  const files = report.files;
  if (!Array.isArray(files) || (!files.length && !allowEmpty) || files.some(f => typeof f.path !== 'string' ||
      !/^test\/[\w./-]+$/.test(f.path) || f.path.split('/').includes('..') || typeof f.success !== 'boolean') ||
      new Set(files.map(f => f.path)).size !== files.length || report.summary?.files !== files.length ||
      report.summary.passed !== files.filter(f => f.success).length ||
      report.summary.failed !== files.filter(f => !f.success).length ||
      !Number.isInteger(report.summary.skippedChecks) || report.summary.skippedChecks < 0 ||
      !Array.isArray(report.excluded)) fail('unit selection/outcome counts differ.');
  return { platform, ...(part ? { part } : {}), files: files.map(f => f.path), summary: report.summary,
    excluded: report.excluded, ...(report.notRun ? { notRun: report.notRun } : {}) };
}

export function stagePriorRun({ checked, downloaded, out }) {
  if (checked.origin !== 'github-actions' || !commit(checked.head) || !commit(checked.base)) fail('missing verified source.');
  const selected = [], files = [];
  for (const artifact of checked.artifacts) {
    const name = `${artifact.name}/${artifact.file.path}`;
    const bytes = bytesAt(downloaded, name, artifact.file.sha256);
    const platform = artifact.name.replace(/^(results|coverage)-/, '');
    if (artifact.name.startsWith('results-')) selected.push(reportSelection(bytes, { platform,
      part: checked.scope !== 'suite' ? path.basename(path.dirname(artifact.file.path)) : undefined,
      allowEmpty: checked.scope !== 'suite' }));
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
  if (receipt.origin !== 'github-actions' || typeof receipt.scope !== 'string' || receipt.head !== head || receipt.base !== base ||
      !positive(receipt.run) || !positive(receipt.attempt) || !receipt.jobs?.length ||
      receipt.jobs.some(job => !hash(job.logSha256) || (job.checkoutHead !== head &&
        !(job.sourceIdentity?.mode === 'verified-merge-tree' && job.sourceIdentity.requestedHead === head &&
          job.sourceIdentity.testedHead === job.checkoutHead && commit(job.sourceIdentity.tree) &&
          job.sourceIdentity.parents?.includes(head) && (job.sourceIdentity.testedBase === base ||
            job.sourceIdentity.reviewBaseParents?.includes(job.sourceIdentity.testedBase)))))) {
    fail('source receipt target/proof differs.');
  }
  for (const saved of receipt.files) bytesAt(folder, saved.path, saved.sha256);
  return { selected: receipt.selected.map(({ platform, part, files }) => ({ platform, ...(part ? { part } : {}), files })),
    provenance: { origin: 'github-actions', selection: receipt.scope,
      scope: receipt.scope === 'suite' ? 'Prior CI unit selection only (TESTS=test); auxiliary repro excluded.'
        : `Prior CI selection (actual TESTS=${JSON.stringify(receipt.jobs[0].producer.tests)}); all producer-selected parts retained.`,
      productCommit: head, base, workflowHead: receipt.workflowHead,
      attempt: { id: String(receipt.run), number: receipt.attempt }, artifacts: receipt.artifacts,
      jobs: receipt.jobs, summaries: receipt.selected.map(({ platform, part, summary, excluded, notRun }) =>
        ({ platform, ...(part ? { part } : {}), summary, excluded, ...(notRun ? { notRun } : {}) })) } };
}
