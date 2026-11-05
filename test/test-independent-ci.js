/** Real cross-version fixtures: old products need no test framework or coverage script. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ci from './helpers/independent-ci.js';

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-independent-')));
const git = (root, ...args) => {
  const r = spawnSync('git', ['-C', root, ...args], {encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true}); fs.writeFileSync(path.join(root,file),text); };
function commit(root, message) {
  git(root,'add','-A'); git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm',message);
  return git(root,'rev-parse','HEAD');
}
function fixture() {
  const root=temp(); git(root,'init','-q');
  write(root,'.gitignore','node_modules/\ndist/\ntest-results/\ncoverage/\n');
  write(root,'package.json',JSON.stringify({name:'fixture',version:'1.0.0',type:'module',scripts:{build:'node build.cjs'}}));
  write(root,'package-lock.json',JSON.stringify({name:'fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0'}}}));
  write(root,'build.cjs',"require('node:fs').mkdirSync('dist',{recursive:true}); require('node:fs').copyFileSync('src/a.js','dist/a.js');\n");
  write(root,'src/a.js',"export const answer = value => value ? 1 : 2;\n");
  write(root,'test/test-answer.js',"import assert from 'node:assert/strict'; import {answer} from '../dist/a.js'; assert.equal(answer(true),1);\n");
  const old=commit(root,'old product and tests without framework');
  write(root,'src/a.js',"export const answer = value => value ? 3 : 4;\n");
  write(root,'test/test-answer.js',"import assert from 'node:assert/strict'; import {answer} from '../dist/a.js'; assert.equal(answer(false),4);\n");
  const newer=commit(root,'new product and tests');
  return {root,old,newer};
}
test('old product without coverage script runs selected tests with real remapped c8 coverage',async()=> {
  const {root,old}=fixture();
  try {
    const out=path.join(root,'test-results','selected');
    const exit=await ci.runIndependent({root,product:old,tests:old,harnessRoot,outDir:out,selection:'test'});
    assert.equal(exit,0);
    const receipt=JSON.parse(fs.readFileSync(path.join(out,'execution.json')));
    assert.equal(receipt.product,old); assert.equal(receipt.tests,old);
    assert.match(receipt.harness,/^[a-f0-9]{40}$/); assert.equal(receipt.phase,'complete');
    const summary=JSON.parse(fs.readFileSync(path.join(out,'coverage/coverage-summary.json')));
    const keys=Object.keys(summary).filter(key=>key!=='total');
    assert.equal(keys.length,1); assert.match(keys[0].replaceAll('\\','/'),/\/src\/a.js$/);
    assert.ok(summary.total.branches.covered < summary.total.branches.total,'unexecuted branch remains uncovered');
    const results=JSON.parse(fs.readFileSync(path.join(out,'test-results/suite/results.json')));
    assert.equal(results.summary.files,1); assert.equal(results.summary.failed,0);
    assert.equal(git(root,'status','--porcelain'),'','source checkout is unchanged');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('new tests on old product and old tests on new product report real failures in both directions',async()=> {
  const {root,old,newer}=fixture();
  try {
    for (const [product,tests] of [[old,newer],[newer,old]]) {
      const out=path.join(root,'test-results',product.slice(0,7));
      assert.equal(await ci.runIndependent({root,product,tests,harnessRoot,outDir:out,selection:'test'}),1);
      const receipt=JSON.parse(fs.readFileSync(path.join(out,'execution.json')));
      assert.equal(receipt.product,product); assert.equal(receipt.tests,tests); assert.notEqual(receipt.exit,0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(out,'test-results/suite/results.json'))).summary.failed,1);
      assert.ok(fs.existsSync(path.join(out,'coverage/coverage-final.json')),'failed tests still produce coverage');
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('execution environment removes tokens, provider credentials and publication channels',()=> {
  assert.equal(typeof ci.executionEnv,'function');
  const env=ci.executionEnv({PATH:'path',HOME:'home',GH_TOKEN:'secret',GITHUB_TOKEN:'secret',OPENAI_API_KEY:'secret',SOME_DATABASE_URL:'secret',GITHUB_OUTPUT:'output',GITHUB_ENV:'env',NODE_OPTIONS:'--import injected.js'});
  assert.deepEqual(env,{PATH:'path',HOME:'home',DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1',DC_FLAG_URL:'http://127.0.0.1:9/'});
});
test('receipts reject stale identities, failed execution and missing/mismatched output manifests',()=> {
  assert.equal(typeof ci.verifyExecution,'function');
  const expected={product:'a'.repeat(40),tests:'b'.repeat(40),harness:'c'.repeat(40),run:'12',attempt:'2'};
  const good={...expected,phase:'complete',exit:0,outputs:[{file:'coverage/coverage-summary.json',sha256:'d'.repeat(64)}]};
  assert.doesNotThrow(()=>ci.verifyExecution(good,expected));
  for (const change of [{product:'e'.repeat(40)},{tests:'e'.repeat(40)},{harness:'e'.repeat(40)},{run:'11'},{attempt:'1'},{exit:1},{phase:'build'},{outputs:[]}]) assert.throws(()=>ci.verifyExecution({...good,...change},expected));
});
