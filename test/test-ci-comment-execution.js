/** Result publication must not turn stale or missing execution evidence into green coverage. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('comment rejects missing and stale evidence, accepts matching result hashes',()=> {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dc-comment-proof-')));
  try {
    const results=path.join(dir,'results-ubuntu-latest'); const coverage=path.join(dir,'coverage-ubuntu-latest');
    fs.mkdirSync(path.join(results,'suite'),{recursive:true}); fs.mkdirSync(coverage);
    const resultFile=path.join(results,'suite/results.json');
    const summaryFile=path.join(coverage,'coverage-summary.json');
    fs.writeFileSync(resultFile,JSON.stringify({suite:'suite',files:[{path:'test/test-example.js',success:true,skipped:[]}]}));
    const metric={covered:10,total:10,pct:100};
    fs.writeFileSync(summaryFile,JSON.stringify({total:{lines:metric,branches:metric,functions:metric}}));
    const expected={product:'a'.repeat(40),tests:'b'.repeat(40),harness:'c'.repeat(40),run:'1',attempt:'1'};
    const render=()=> {
      const answer=spawnSync(process.execPath,[path.join(root,'test/ci-comment.js'),dir],{encoding:'utf8',env:{...process.env,GH_TOKEN:'',PR:'',RUN_ID:'1',HEAD_SHA:expected.product,TESTS_FROM:expected.tests,HARNESS_SHA:expected.harness,REQUIRE_EXECUTION:'true',GITHUB_RUN_ATTEMPT:'1'}});
      assert.equal(answer.status,0,answer.stderr); return answer.stdout;
    };
    assert.match(render(),/execution provenance/); assert.match(render(),/❌/);
    const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const receipt={...expected,phase:'complete',exit:0,outputs:[{file:'test-results/suite/results.json',sha256:hash(resultFile)},{file:'coverage/coverage-summary.json',sha256:hash(summaryFile)}]};
    fs.writeFileSync(path.join(results,'execution.json'),JSON.stringify(receipt));
    assert.match(render(),/✅ 1 of 1 files passed/);
    fs.writeFileSync(path.join(results,'execution.json'),JSON.stringify({...receipt,product:'d'.repeat(40)}));
    assert.match(render(),/Execution identity mismatch: product/);
    fs.writeFileSync(path.join(results,'execution.json'),JSON.stringify(receipt));
    fs.appendFileSync(resultFile,' '); assert.match(render(),/Missing or changed execution output/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
