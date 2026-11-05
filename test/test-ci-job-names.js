/** Reusable-workflow prefixes select the same artifacts without weakening execution identity. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {platformJobs,resultsArtifactOf,matrixFor} from './helpers/ci-platforms.js';
import {artifactAttempt} from './helpers/execution-evidence.js';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const os='ubuntu-latest';
function job(name,attempt) {
  return {name,id:attempt,run_id:42,run_attempt:attempt,status:'completed',conclusion:'success',
    started_at:'2026-11-01T10:00:00Z',completed_at:'2026-11-01T10:05:00Z',runner_id:100,runner_name:'runner'};
}
function selection(names,resultName=`results-${os}`) {
  return {os,resultName,coverageName:`coverage-${os}`,expected:{run:'42',attempt:'2'},
    receipt:{attempt:'1',exit:0,outputs:[{file:'test-results/suite/results.json'}]},
    jobs:names.flatMap(name=>[job(name,1),job(name,2)]),
    artifacts:[{name:resultName,expired:false,created_at:'2026-11-01T10:04:00Z',workflow_run:{id:42}}]};
}
test('direct and reusable unit jobs are recognized with their full names preserved',()=> {
  const jobs=[job(`unit (${os})`,1),job(`tests / unit (${os})`,1),job('tests / setup',1)];
  assert.deepEqual(platformJobs(jobs,os).map(item=>item.name),[`unit (${os})`,`tests / unit (${os})`]);
});
test('reusable timed job parses its test and existing artifact name',()=> {
  assert.deepEqual(resultsArtifactOf(job(`tests / unit (${os}, repro/test-a.js)`,1),os),
    {test:'repro/test-a.js',artifact:`results-${os}-timed-repro-test-a.js`});
});
test('reusable caller retains its original eligible producer attempt',()=> {
  assert.equal(artifactAttempt(selection([`tests / unit (${os})`])),'1');
});
test('timed reusable jobs bind separately by artifact rather than rejecting different tests',()=> {
  const s=selection([`tests / unit (${os}, test-a.js)`,`tests / unit (${os}, test-b.js)`],`results-${os}-timed-test-a.js`);
  assert.equal(artifactAttempt(s),'1');
});
for(const names of [[`unit (${os})`,`tests / unit (${os})`],[`first / unit (${os})`,`second / unit (${os})`]]) {
  test(`multiple eligible caller producers are refused: ${names.join(', ')}`,()=>assert.throws(()=>artifactAttempt(selection(names))));
}
test('timed matrix refuses different names that share an artifact ID',()=> {
  assert.throws(()=>matrixFor([os],{tests:'timed',timed:['repro/test-a.js','repro-test-a.js']}),/artifact/);
});
test('timed matrix keeps distinct test artifact IDs',()=> {
  const matrix=matrixFor([os],{tests:'timed',timed:['test-a.js','repro/test-a.js']});
  assert.equal(matrix.include.length,2); assert.equal(new Set(matrix.include.map(item=>item.id)).size,2);
});
test('existing Tests workflow owns native and trusted legacy events without a wrapper',()=> {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const text=fs.readFileSync(path.join(root,'.github/workflows/tests.yml'),'utf8');
  assert.match(text,/\n  pull_request_target:\s*\n    types: \[synchronize, reopened, labeled\]/);
  assert.match(text,/\n  pull_request:\s*\n    types: \[synchronize, reopened, labeled\]/);
  assert.doesNotMatch(text,/\n  workflow_call:/);
  assert.equal(fs.existsSync(path.join(root,'.github/workflows/label-router.yml')),false);
  assert.match(text,/ref: \$\{\{ github.event_name != 'pull_request' && needs.platforms.outputs.sha \|\| '' \}\}/);
});
