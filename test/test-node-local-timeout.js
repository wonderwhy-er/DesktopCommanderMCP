/** node:local forwards finite scripts to Fleet; its timeout controls response observation. */
import assert from 'node:assert/strict';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';
export default async function runTests() {
 const original=terminalManager.executeFiniteCommand;
 const calls=[];
 terminalManager.executeFiniteCommand=async (invocation,shell,wait) => {
  calls.push({invocation,wait});
  return {pid:123,operationId:'fleet-finite-test',output:'',isBlocked:true,
   processState:{isRunning:true,isFinished:false,isWaitingForInput:false}};
 };
 const session=await startProcess({mode:'interactive',command:'node:local',timeout_ms:20000});
 const pid=session.structuredContent.pid;
 try {
  const code="console.log('finite script')";
  const result=await interactWithProcess({pid,input:code});
  assert.equal(calls[0].invocation.executable,process.execPath);
  assert.deepEqual(calls[0].invocation.argv,['--input-type=module']);
  assert.equal(calls[0].invocation.input,code);
  assert.equal(calls[0].wait,20000);
  assert.equal(result.structuredContent.operationId,'fleet-finite-test');
  assert.equal(result.structuredContent.status,'running');
  await interactWithProcess({pid,input:code,timeout_ms:123});
  assert.equal(calls[1].wait,123);
 } finally { terminalManager.executeFiniteCommand=original; await forceTerminate({pid}); }
}
runIfMain(import.meta.url,runTests);
