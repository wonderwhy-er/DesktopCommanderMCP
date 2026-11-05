/** Exercise the privileged metadata entrypoint against a local GitHub API fixture. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function routeCLI({staleProbe=false,probeFailure=false,native=false,trigger='mihailt'}={}) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dc-route-cli-')));
  const repo='wonderwhy-er/DesktopCommanderMCP';
  const pull={number:12,state:'open',user:{login:'mihailt'},head:{sha:'a'.repeat(40),repo:{full_name:repo}},base:{sha:'b'.repeat(40),repo:{full_name:repo}},labels:[{name:'linux'}]};
  const event={action:'labeled',sender:{login:'mihailt'},label:{name:'linux'},pull_request:pull};
  const eventFile=path.join(dir,'event.json'),outputFile=path.join(dir,'output');
  fs.writeFileSync(eventFile,JSON.stringify(event));
  let reads=0;const requests=[];
  const server=http.createServer((request,response)=> {
    requests.push(request.url);
    let status=200,body={};
    if(request.url.includes('/collaborators/'))body={permission:'write'};
    else if(request.url.endsWith('/pulls/12')) {
      body=structuredClone(pull);
      if(staleProbe && reads++===0)body.head.sha='c'.repeat(40);
    } else if(request.url.includes('/contents/')) {status=probeFailure?503:native?200:404;body={message:'fixture'};}
    else status=404;
    response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const execution=await new Promise((resolve,reject)=> {
      const child=spawn(process.execPath,[path.join(root,'test/ci-label-route.js')],{env:{...process.env,
        GITHUB_REPOSITORY:repo,GITHUB_EVENT_NAME:'pull_request_target',GITHUB_EVENT_PATH:eventFile,
        GITHUB_ACTOR:'mihailt',GITHUB_TRIGGERING_ACTOR:trigger,GITHUB_OUTPUT:outputFile,
        GITHUB_API_URL:`http://127.0.0.1:${server.address().port}`,GH_TOKEN:'fixture'}});
      let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
    });
    return {...execution,requests,output:fs.existsSync(outputFile)?fs.readFileSync(outputFile,'utf8'):''};
  } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
test('metadata CLI routes the selected OS after live permission and workflow probes',async()=> {
  const execution=await routeCLI();assert.equal(execution.code,0,execution.stderr);
  assert.match(execution.output,/os=\["ubuntu-latest"\]/);assert.match(execution.output,/pr=12/);
  assert.equal(execution.requests.filter(url=>url.includes('/contents/')).length,2);
});
test('metadata CLI refuses a changed workflow-probed head',async()=> {
  const execution=await routeCLI({staleProbe:true});assert.equal(execution.code,0);assert.match(execution.output,/os=\[\]/);
});
test('metadata CLI defers existing native workflows',async()=> {
  const execution=await routeCLI({native:true});assert.equal(execution.code,0);assert.match(execution.output,/os=\[\]/);
});
test('metadata CLI fails closed on probe API failure',async()=> {
  const execution=await routeCLI({probeFailure:true});assert.notEqual(execution.code,0);assert.equal(execution.output,'');
});
test('metadata CLI rejects an unauthorized rerun before API access',async()=> {
  const execution=await routeCLI({trigger:'outsider'});assert.notEqual(execution.code,0);assert.equal(execution.requests.length,0);
});
