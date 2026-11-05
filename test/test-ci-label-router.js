import assert from 'node:assert/strict';
import {test} from 'node:test';
import {legacyRoute} from './helpers/ci-label-router.js';
import {platformsFor} from './helpers/ci-platforms.js';

function fixture() {
  const repo='wonderwhy-er/DesktopCommanderMCP';
  const live={number:12,state:'open',user:{login:'mihailt'},head:{sha:'a'.repeat(40),repo:{full_name:repo}},base:{sha:'b'.repeat(40),ref:'old-feature',repo:{full_name:repo}},labels:['linux','windows','macos'].map(name=>({name}))};
  return {repo,actor:'mihailt',permission:'write',nativeAtHead:false,nativeAtBase:false,probedHead:live.head.sha,probedBase:live.base.sha,live,
    event:{action:'labeled',sender:{login:'mihailt'},label:{name:'windows'},pull_request:structuredClone(live)}};
}
test('missing workflow on old feature base routes added OS while native target handling cannot',()=> {
  const f=fixture(); assert.deepEqual(platformsFor('pull_request_target',f.event),[]);
  assert.deepEqual(legacyRoute(f).os,['windows-latest']); assert.equal(legacyRoute(f).sha,f.live.head.sha);
});
test('review label reviews alone and pushes run all labelled OS',()=> {
  const f=fixture(); f.live.labels.push({name:'review'}); f.event.label.name='review';
  assert.equal(legacyRoute(f).review,true); assert.deepEqual(legacyRoute(f).os,[]);
  f.event.action='synchronize'; assert.deepEqual(legacyRoute(f).os,['ubuntu-latest','windows-latest','macos-latest']);
  assert.equal(legacyRoute(f).review,true);
});
for (const [name,change] of [
  ['unauthorized actor',f=>{f.actor='outsider';f.event.sender.login='outsider';}],
  ['actor input impersonation',f=>{f.event.sender.login='outsider';}],
  ['reader permission',f=>{f.permission='read';}],
  ['nonmaintainer author',f=>{f.live.user.login='outsider';}],
  ['fork',f=>{f.live.head.repo.full_name='fork/repo';}],
  ['stale head',f=>{f.live.head.sha='c'.repeat(40);}],
  ['stale base',f=>{f.live.base.sha='c'.repeat(40);}],
  ['head differs from workflow-probed snapshot',f=>{f.probedHead='c'.repeat(40);}],
  ['base differs from workflow-probed snapshot',f=>{f.probedBase='c'.repeat(40);}],
  ['closed PR',f=>{f.live.state='closed';}],
  ['removed label',f=>{f.live.labels=[];}],
  ['existing head workflow',f=>{f.nativeAtHead=true;}],
  ['existing base workflow',f=>{f.nativeAtBase=true;}],
  ['unknown presence',f=>{f.nativeAtBase=undefined;}],
  ['opened duplicate',f=>{f.event.action='opened';}],
]) test(`fallback refuses ${name}`,()=>{const f=fixture();change(f);assert.deepEqual(legacyRoute(f).os,[]);assert.equal(legacyRoute(f).review,false);});
test('ordinary native label path stays unchanged',()=> {
  const f=fixture(); assert.deepEqual(platformsFor('pull_request',f.event),['windows']);
  f.nativeAtHead=true; assert.deepEqual(legacyRoute(f).os,[]);
});
