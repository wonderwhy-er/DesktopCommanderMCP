/** Retried publication accepts retained executions, never stale artifacts from a replaced producer. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as evidence from './helpers/execution-evidence.js';

const expected={run:'42',harness:'c'.repeat(40),attempt:'3'};
const times={old:['2026-11-01T10:00:00Z','2026-11-01T10:05:00Z'],new:['2026-11-01T10:10:00Z','2026-11-01T10:15:00Z']};
function job(os,attempt,when='old',conclusion='success') {
  return {name:`unit (${os})`,id:attempt,run_id:42,run_attempt:attempt,status:'completed',conclusion,
    started_at:times[when][0],completed_at:times[when][1],runner_id:100,runner_name:'runner'};
}
function artifact(name,when='old') {
  return {name,id:1,expired:false,created_at:when==='old'?'2026-11-01T10:04:00Z':'2026-11-01T10:14:00Z',workflow_run:{id:42,head_sha:expected.harness}};
}
function selection(os='ubuntu-latest',attempt='1',when='old') {
  return {os,receipt:{attempt,outputs:[{file:'test-results/suite/results.json'},{file:'coverage/coverage-summary.json'}]},expected,
    resultName:`results-${os}`,coverageName:`coverage-${os}`,jobs:[job(os,1),job(os,2)],
    artifacts:[artifact(`results-${os}`,when),artifact(`coverage-${os}`,when)]};
}
test('mixed original Linux/Windows and rerun macOS producer attempts remain strict',()=> {
  assert.equal(typeof evidence.artifactAttempt,'function');
  for(const os of ['ubuntu-latest','windows-latest']) assert.equal(evidence.artifactAttempt(selection(os)),'1');
  const mac=selection('macos-latest','2','new'); mac.jobs=[job('macos-latest',1,'old','failure'),job('macos-latest',2,'new')];
  assert.equal(evidence.artifactAttempt(mac),'2');
});
test('post-only rerun accepts retained successful execution despite a newer cloned job ID',()=> {
  assert.equal(typeof evidence.artifactAttempt,'function');
  const s=selection();s.jobs.push({...job(s.os,3),id:999});
  assert.equal(evidence.artifactAttempt(s),'1');
});
for(const [name,change] of [
  ['latest failed producer',s=>{s.jobs[1]=job(s.os,2,'new','failure');}],
  ['genuinely newer successful producer with stale receipt',s=>{s.jobs[1]=job(s.os,2,'new');}],
  ['latest producer has no replacement artifact',s=>{s.jobs[1]=job(s.os,2,'new');s.receipt.attempt='2';}],
  ['original producer is missing',s=>{s.jobs=s.jobs.slice(1);}],
  ['all producer metadata missing',s=>{s.jobs=[];}],
  ['results artifact metadata missing',s=>{s.artifacts=s.artifacts.slice(1);}],
  ['coverage artifact metadata missing',s=>{s.artifacts=s.artifacts.slice(0,1);}],
  ['wrong run metadata',s=>{s.artifacts[0].workflow_run.id=43;}],
  ['wrong harness metadata',s=>{s.artifacts[0].workflow_run.head_sha='d'.repeat(40);}],
  ['changed runner execution',s=>{s.jobs[1].runner_id=101;}],
  ['producer from a future attempt',s=>{s.jobs.push(job(s.os,4));}],
]) test(`publication rejects ${name}`,()=> {
  assert.equal(typeof evidence.artifactAttempt,'function');
  const s=selection();change(s);assert.throws(()=>evidence.artifactAttempt(s));
});
