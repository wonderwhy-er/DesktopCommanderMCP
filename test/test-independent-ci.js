/** Real cross-version fixtures: old products need no test framework or coverage script. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ci from './helpers/independent-ci.js';
import {verifyArtifacts} from './helpers/execution-evidence.js';

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
  write(root,'.gitignore','node_modules/\ndist/\ncoverage/\n');
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
    assert.deepEqual(keys,['src/a.js'],'removed-on-main product sources keep stable cross-platform identities');
    const final=JSON.parse(fs.readFileSync(path.join(out,'coverage/coverage-final.json')));
    assert.deepEqual(Object.keys(final),['src/a.js']); assert.equal(final['src/a.js'].path,'src/a.js');
    assert.match(fs.readFileSync(path.join(out,'coverage/lcov.info'),'utf8'),/^SF:src\/a.js$/m);
    assert.ok(summary.total.branches.covered < summary.total.branches.total,'unexecuted branch remains uncovered');
    const results=JSON.parse(fs.readFileSync(path.join(out,'test-results/suite/results.json')));
    assert.equal(results.summary.files,1); assert.equal(results.summary.failed,0);
    assert.equal(git(root,'status','--porcelain','--untracked-files=no'),'','tracked source checkout is unchanged');
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
test('TypeScript coverage uses the selected product source map',async()=> {
  const {root}=fixture();
  try {
    fs.rmSync(path.join(root,'src/a.js'));
    write(root,'src/a.ts','export const answer = (value: boolean): number => value ? 1 : 2;\n');
    write(root,'tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',types:[],skipLibCheck:true},include:['src/**/*.ts']}));
    const compiler=path.join(harnessRoot,'node_modules/typescript/bin/tsc').replaceAll('\\','/');
    write(root,'package.json',JSON.stringify({name:'fixture',version:'1.0.0',type:'module',scripts:{build:`node "${compiler}" -p tsconfig.json`}}));
    write(root,'test/test-answer.js',"import assert from 'node:assert/strict'; import {answer} from '../dist/a.js'; assert.equal(answer(true),1);\n");
    const product=commit(root,'TypeScript product without coverage framework');
    const out=path.join(root,'test-results/ts');
    assert.equal(await ci.runIndependent({root,product,tests:product,harnessRoot,outDir:out,selection:'test'}),0);
    const report=JSON.parse(fs.readFileSync(path.join(out,'coverage/coverage-summary.json')));
    assert.deepEqual(Object.keys(report).filter(key=>key!=='total').map(key=>key.replaceAll('\\','/').split('/').slice(-2).join('/')),['src/a.ts']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('successful process without results fails and replaces stale output',async()=> {
  const {root,old}=fixture();
  try {
    const out=path.join(root,'test-results/missing'); write(out,'coverage/stale.json','stale');
    const command=(exe,args,cwd,env)=>args.some(arg=>arg.endsWith('/test/run-ci.js') || arg.endsWith('\\test\\run-ci.js')) ? 0 : spawnSync(exe,args,{cwd,env,stdio:'ignore'}).status;
    assert.equal(await ci.runIndependent({root,product:old,tests:old,harnessRoot,outDir:out,selection:'test',command}),1);
    assert.equal(fs.existsSync(path.join(out,'coverage/stale.json')),false);
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(out,'execution.json'))).phase,'complete');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('publication refuses a missing receipt, stale receipt and modified result bytes',()=> {
  const dir=temp();
  try {
    const expected={product:'a'.repeat(40),tests:'b'.repeat(40),harness:'c'.repeat(40),run:'1',attempt:'1'};
    assert.throws(()=>verifyArtifacts({results:dir,coverage:dir,expected}));
    write(dir,'execution.json',JSON.stringify({...expected,phase:'complete',exit:0,outputs:[{file:'test-results/suite/results.json',sha256:'d'.repeat(64)}]}));
    assert.throws(()=>verifyArtifacts({results:dir,coverage:dir,expected}));
    write(dir,'suite/results.json','modified');
    assert.throws(()=>verifyArtifacts({results:dir,coverage:dir,expected}));
    assert.throws(()=>verifyArtifacts({results:dir,coverage:dir,expected:{...expected,product:'e'.repeat(40)}}));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('output guard rejects source roots, ancestors and Windows case aliases before deletion',()=> {
  const dir=temp();
  try {
    const source=path.join(dir,'source');fs.mkdirSync(source);write(source,'keep.txt','keep');
    assert.throws(()=>ci.safeOutput(source,[source]),/source checkout/);
    assert.throws(()=>ci.safeOutput(dir,[source]),/source checkout/);
    assert.throws(()=>ci.safeOutput(path.parse(source).root,[source]),/source checkout/);
    write(source,'src/keep.js','keep'); fs.mkdirSync(path.join(source,'.git'));
    assert.throws(()=>ci.safeOutput(path.join(source,'src'),[source]),/source checkout/);
    assert.throws(()=>ci.safeOutput(path.join(source,'.git'),[source]),/source checkout/);
    if (process.platform==='win32') assert.throws(()=>ci.safeOutput(source.toUpperCase(),[source]),/source checkout/);
    assert.equal(ci.safeOutput(path.join(dir,'output'),[source]),path.join(dir,'output'));
    assert.equal(fs.readFileSync(path.join(source,'keep.txt'),'utf8'),'keep');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
