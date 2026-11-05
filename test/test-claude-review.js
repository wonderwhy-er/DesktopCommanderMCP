import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { askClaude } from './helpers/claude-review.js';

const fixture = `import fs from 'node:fs';
const args = process.argv.slice(2);
if(args.includes('--version')) { console.log('2.1.293 (Claude Code)'); process.exit(0); }
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'}));process.exit(0);}
const opt = n => args[args.indexOf(n)+1];
let prompt=''; for await(const part of process.stdin) prompt+=part;
const config=JSON.parse(opt('--mcp-config'));
const url=config.mcpServers.review.url;
let id=0; const rpc=async(method,params)=>{
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 return (await r.json()).result;
};
const init=await rpc('initialize',{protocolVersion:'2025-03-26'});
const tools=await rpc('tools/list',{});
const read=await rpc('tools/call',{name:'read_file',arguments:{path:'pr/a.txt'}});
const denied=await rpc('tools/call',{name:'write_file',arguments:{path:'pr/a.txt',content:'changed'}});
const outside=await rpc('tools/call',{name:'read_file',arguments:{path:'../secret'}});
const budget=await rpc('tools/call',{name:'read_file',arguments:{path:'pr/a.txt'}});
fs.writeFileSync('observed.json',JSON.stringify({args,prompt,env:process.env,init,tools,read,denied,outside,budget}));
if(prompt==='timeout') await new Promise(r=>setTimeout(r,10000));
const result={type:'result',subtype:'success',is_error:false,num_turns:2,result:JSON.stringify({summary:'Checked.',findings:[]}),modelUsage:{'claude-haiku-5-5':{inputTokens:12,outputTokens:5,cacheReadInputTokens:3,cacheCreationInputTokens:2}}};
if(prompt==='failure') { result.is_error=true; result.result='Company credential rejected.'; result.error={type:'authentication_error',message:'Rejected '+process.env.ANTHROPIC_API_KEY}; console.error('Provider fixture rejection '+process.env.ANTHROPIC_API_KEY); }
if(prompt==='secret') result.result=JSON.stringify({summary:process.env.ANTHROPIC_API_KEY,findings:[]});
if(prompt==='fallback') result.modelUsage={'claude-sonnet-5-5':{inputTokens:12,outputTokens:5}};
if(prompt==='empty') result.result='';
console.log(JSON.stringify(result));`;

function setup() {
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'claude-review-test-'));
 fs.mkdirSync(path.join(folder,'pr')); fs.mkdirSync(path.join(folder,'review'));
 fs.writeFileSync(path.join(folder,'pr/a.txt'),'frozen source');
 const cli=path.join(folder,'fake.mjs'); fs.writeFileSync(cli,fixture);
 const options={folder,cli,key:'fixture-api-only',calls:3,timeoutMs:3000,maxTurns:20,out:path.join(folder,'out'),prompt:'review',environment:{...process.env,GH_TOKEN:'github-secret-fixture',OPENAI_API_KEY:'openai-secret-fixture',CLAUDE_CODE_OAUTH_TOKEN:'unused-oauth-fixture',ANTHROPIC_AUTH_TOKEN:'unused-bearer-fixture'}};
 return {folder,options};
}

test('API-key-only Claude child uses the pinned model and the existing bounded read broker',async()=>{
 const {folder,options}=setup();
 try {
  const answer=await askClaude(options);
  const seen=JSON.parse(fs.readFileSync(path.join(folder,'observed.json')));
  assert.equal(JSON.parse(answer.response).summary,'Checked.');
  assert.equal(seen.env.ANTHROPIC_API_KEY,options.key);
  for(const name of ['GH_TOKEN','OPENAI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_AUTH_TOKEN']) assert.equal(seen.env[name],undefined);
  assert.equal(seen.args[seen.args.indexOf('--model')+1],'claude-haiku-5-5');
  assert.equal(seen.args[seen.args.indexOf('--effort')+1],'medium');
  assert.equal(seen.args[seen.args.indexOf('--tools')+1],'');
  assert.ok(seen.args.includes('--strict-mcp-config')); assert.ok(seen.args.includes('--bare'));
  assert.ok(!JSON.stringify(seen.args).includes(options.key));
  assert.notEqual(seen.env.HOME,process.env.HOME); assert.notEqual(seen.env.USERPROFILE,process.env.USERPROFILE);
  assert.match(seen.read.content[0].text,/frozen source/);
  assert.match(seen.denied.content[0].text,/denied/); assert.match(seen.outside.content[0].text,/denied/);
  assert.match(seen.budget.content[0].text,/budget/);
  assert.equal(fs.readFileSync(path.join(folder,'pr/a.txt'),'utf8'),'frozen source');
  assert.equal(answer.stats.models['claude-haiku-5-5'].tokens.total,22);
  assert.equal(answer.stats.tools.totalSuccess,1);
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('missing API key, wrong model, provider failure, credential echo and timeout fail closed',async()=>{
 const {folder,options}=setup();
 try {
  await assert.rejects(askClaude({...options,key:''}),/No Anthropic API key/);
  for(const prompt of ['failure','secret','fallback','empty','timeout']) {
   await assert.rejects(askClaude({...options,prompt,timeoutMs:prompt==='timeout'?250:3000}),/Claude|credential|model|timeout|answer/i);
   const saved=fs.readdirSync(options.out).map(name=>fs.readFileSync(path.join(options.out,name),'utf8')).join('');
   assert.ok(!saved.includes(options.key));
  }
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});


test('native failure envelope and provider reason survive separately from the adapter receipt',async()=>{
 const {folder,options}=setup();
 try {
  await assert.rejects(askClaude({...options,prompt:'failure'}),/did not complete/);
  const native=JSON.parse(fs.readFileSync(path.join(options.out,'answer.json'),'utf8'));
  assert.equal(native.error.type,'authentication_error');
  assert.equal(native.result,'Company credential rejected.');
  assert.equal(native.error.message,'Rejected <redacted>');
  const receipt=JSON.parse(fs.readFileSync(path.join(options.out,'adapter-error.json'),'utf8'));
  assert.match(receipt.error,/did not complete/);
  const stderr=fs.readFileSync(path.join(options.out,'cli-stderr.txt'),'utf8');
  assert.match(stderr,/Provider fixture rejection <redacted>/);
  const artifacts=fs.readdirSync(options.out).map(name=>fs.readFileSync(path.join(options.out,name),'utf8')).join('');
  assert.ok(!artifacts.includes(options.key));
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
