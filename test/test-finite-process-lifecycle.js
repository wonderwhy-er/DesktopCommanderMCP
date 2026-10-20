import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFleetFiniteCommand, finiteOwnerFailed } from '../dist/fleet-finite-command.js';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';

// A protocol peer, never a second process executor. The target executable is
// deliberately nonexistent: executing it locally instead of delegating fails.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-owner-peer-'));
const originalPath = process.env.PATH;
await fs.writeFile(path.join(directory, 'ai-fleet'), `#!${process.execPath}
const readline = require('node:readline');
const schema = 'test-retained-owner/v1';
const write = value => console.log(JSON.stringify({schema,...value}));
write({ready:true});
let admission;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.operation==='execute') {
   if(m.input.executable!=='/owner-only-target' || !m.input.requireCancellation || 'max_duration_ms' in m.input) throw Error('wrong invocation');
   admission={operationId:m.operationId,policy:{executorBinding:m.input.argv[0]},limits:{deadlineMilliseconds:123,outputMegabytes:2}};
   write({id:m.id,admission});
   if(m.input.argv[1]==='disconnect') return process.exit(7);
   if(m.input.argv[1]!=='cancel') setTimeout(()=>write({id:1,receipt:{admission,evidence:{executor:{kind:m.input.argv[0]},result:{terminal:'output-exceeded',cleanup:'complete',cleanupComplete:true,exitCode:null,capturedBytes:{stdout:[65],stderr:[]}}}}}),30);
 } else if(m.operation==='cancel') {
   write({id:m.id,control:{state:'cancellation-requested'}});
   write({id:1,receipt:{admission,evidence:{result:{terminal:'cancelled',cleanup:'complete',cleanupComplete:true,exitCode:null}}}});
 }
});
`, {mode:0o755});
process.env.PATH = directory + path.delimiter + originalPath;
test.after(async () => { process.env.PATH = originalPath; await fs.rm(directory,{recursive:true,force:true}); });
const invoke = (binding, action='finish') => startFleetFiniteCommand({executable:'/owner-only-target',argv:[binding,action],cwd:directory}, '/bin/sh');

for (const binding of ['with-limits/ai-fleet-execution-darwin','conflux-bounded-process/ai-fleet-execution-darwin']) {
 test('preserves selected owner and original receipt: '+binding, async () => {
  const command=invoke(binding); const receipt=await command.completion;
  assert.equal(receipt.admission.policy.executorBinding,binding);
  assert.equal(receipt.evidence.result.terminal,'output-exceeded');
  assert.equal(receipt.admission.limits.outputMegabytes,2);
  assert.equal(finiteOwnerFailed(receipt),true);
 });
}
test('cancellation before transport readiness reaches the retained owner', async () => {
 const command=invoke('conflux-bounded-process/ai-fleet-execution-darwin','cancel');
 const control=await command.cancel();
 assert.equal(control.state,'cancellation-requested');
 assert.equal((await command.completion).evidence.result.terminal,'cancelled');
});
test('transport loss exposes durable identity without replay or fallback execution', async () => {
 const command=invoke('conflux-bounded-process/ai-fleet-execution-darwin','disconnect');
 await assert.rejects(command.completion,error=>error.message.includes(command.operationId)&&error.message.includes('finite-command show'));
});
test('retired private limits are refused', async () => {
 for(const opts of [{max_duration_ms:1},{max_output_bytes:1}]) {
  assert.equal((await startProcess({command:'should-not-run',timeout_ms:10,...opts})).isError,true);
 }
});
test('explicit interactive Node keeps stdin and state between calls', async () => {
 const result=await startProcess({command:'"'+process.execPath+'" -i',mode:'interactive',timeout_ms:3000});
 const pid=result.structuredContent.pid;
 try {
  await interactWithProcess({pid,input:'var ownerValue = 21',timeout_ms:1000});
  const answer=await interactWithProcess({pid,input:'ownerValue * 2',timeout_ms:1000});
  assert.match(answer.content[0].text,/42/);
 } finally { await forceTerminate({pid}); }
});
