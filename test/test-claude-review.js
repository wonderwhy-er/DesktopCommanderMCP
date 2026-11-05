import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import vm from 'node:vm';
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
const modes={list:['list_directory',{path:'pr'}],glob:['glob',{pattern:'missing*'}],
 grep:['grep_search',{pattern:'missing-pattern'}],review:['read_file',{path:'review/note.txt'}],
 traversal:['read_file',{path:'pr/../review/note.txt'}],missing:['read_file',{path:'pr/missing'}],
 normalized:['read_file',{path:'pr/sub/../a.txt'}],pemsource:['read_file',{path:'pr/pem.txt'}],
 eof:['read_file',{path:'pr/a.txt',start_line:999}],emptyfile:['read_file',{path:'pr/empty.txt'}]};
const mode=prompt.startsWith('source-guard:')?modes[prompt.slice('source-guard:'.length)]:undefined;
const read=await rpc('tools/call',mode?{name:mode[0],arguments:mode[1]}:{name:'read_file',arguments:{path:'pr/a.txt'}});
const denied=await rpc('tools/call',{name:'write_file',arguments:{path:'pr/a.txt',content:'changed'}});
const outside=await rpc('tools/call',{name:'read_file',arguments:{path:'../secret'}});
const budget=await rpc('tools/call',{name:'read_file',arguments:{path:'pr/a.txt'}});
fs.writeFileSync('observed.json',JSON.stringify({args,prompt,env:process.env,init,tools,read,denied,outside,budget}));
if(prompt==='timeout') await new Promise(r=>setTimeout(r,30000));
const result={type:'result',subtype:'success',is_error:false,num_turns:2,result:JSON.stringify({summary:'Checked.',findings:[]}),modelUsage:{'claude-haiku-5-5':{inputTokens:12,outputTokens:5,cacheReadInputTokens:3,cacheCreationInputTokens:2}}};
if(prompt==='failure') { result.is_error=true; result.result='Company credential rejected.'; result.error={type:'authentication_error',message:'Rejected '+process.env.ANTHROPIC_API_KEY}; console.error('Provider fixture rejection '+process.env.ANTHROPIC_API_KEY); }
if(prompt==='secret') result.result=JSON.stringify({summary:process.env.ANTHROPIC_API_KEY,findings:[]});
if(prompt==='pattern-answer') result.result=JSON.stringify({summary:'sk-ant-'+ 'q'.repeat(32),findings:[]});
if(prompt==='pem-answer') result.result=JSON.stringify({summary:'-----BEGIN '+'PRIVATE KEY-----\\n'
 +'synthetic-pem-body-'+'x'.repeat(32)+'\\n-----END PRIVATE KEY-----',findings:[]});
if(prompt==='fallback') result.modelUsage={'claude-sonnet-5-5':{inputTokens:12,outputTokens:5}};
if(prompt==='empty') result.result='';
console.log(JSON.stringify(result));`;

function setup() {
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'claude-review-test-'));
 fs.mkdirSync(path.join(folder,'pr')); fs.mkdirSync(path.join(folder,'review'));
 fs.writeFileSync(path.join(folder,'pr/a.txt'),'frozen source');
 fs.writeFileSync(path.join(folder,'pr/empty.txt'),'');
 fs.writeFileSync(path.join(folder,'review/note.txt'),'supplemental evidence');
 const cli=path.join(folder,'fake.mjs'); fs.writeFileSync(cli,fixture);
 const options={folder,cli,key:'fixture-api-only',calls:3,timeoutMs:15000,maxTurns:20,out:path.join(folder,'out'),prompt:'review',environment:{...process.env,GH_TOKEN:'github-secret-fixture',OPENAI_API_KEY:'openai-secret-fixture',CLAUDE_CODE_OAUTH_TOKEN:'unused-oauth-fixture',ANTHROPIC_AUTH_TOKEN:'unused-bearer-fixture'}};
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

test('credential-shaped prompts stop before a request and credential-shaped answers never survive artifacts', async () => {
 const {folder,options}=setup();
 const credential='sk-ant-'+'q'.repeat(32);
 try {
  await assert.rejects(askClaude({...options,prompt:`Diff adds ${credential}`}), /input contains a credential/);
  assert.equal(fs.existsSync(path.join(folder,'observed.json')),false);
  await assert.rejects(askClaude({...options,prompt:'pattern-answer'}), /answer contained a credential/);
  const saved=fs.readdirSync(options.out).map(name=>fs.readFileSync(path.join(options.out,name),'utf8')).join('');
  assert.ok(!saved.includes(credential));
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('only a successful normalized pr file read satisfies the source-read guard', async () => {
 const {folder,options}=setup();
 try {
  for(const mode of ['list','glob','grep','review','traversal','missing']) {
   await assert.rejects(askClaude({...options,calls:1,prompt:`source-guard:${mode}`}),
    /read no source/,mode);
  }
  const answer=await askClaude({...options,calls:1,prompt:'source-guard:normalized'});
  assert.equal(answer.stats.tools.totalSuccess,1);
  assert.equal(JSON.parse(answer.response).summary,'Checked.');
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('PEM answer and broker read artifacts retain no key body or end marker', async () => {
 const {folder,options}=setup();
 const body='synthetic-pem-body-'+'x'.repeat(32);
 const pem=['-----BEGIN '+'PRIVATE KEY-----',body,'-----END PRIVATE KEY-----'].join('\n');
 try {
  await assert.rejects(askClaude({...options,prompt:'pem-answer'}), /answer contained a credential/);
  let saved=fs.readdirSync(options.out).map(name=>fs.readFileSync(path.join(options.out,name),'utf8')).join('');
  assert.ok(!saved.includes(body));
  assert.ok(!saved.includes('END PRIVATE KEY'));
  for(const source of [pem,pem.split('\n').slice(0,2).join('\n')]) {
   fs.writeFileSync(path.join(folder,'pr/pem.txt'),source);
   await askClaude({...options,calls:1,prompt:'source-guard:pemsource'});
   const seen=JSON.parse(fs.readFileSync(path.join(folder,'observed.json'),'utf8'));
   assert.ok(!seen.read.content[0].text.includes(body));
   saved=fs.readdirSync(options.out).map(name=>fs.readFileSync(path.join(options.out,name),'utf8')).join('');
   assert.ok(!saved.includes(body));
   assert.ok(!saved.includes('END PRIVATE KEY'));
   for(const line of fs.readFileSync(path.join(options.out,'session.jsonl'),'utf8').trim().split('\n')) {
    assert.doesNotThrow(()=>JSON.parse(line));
   }
  }
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('missing API key, wrong model, provider failure, credential echo and timeout fail closed',async()=>{
 const {folder,options}=setup();
 try {
  await assert.rejects(askClaude({...options,key:''}),/No Anthropic API key/);
  const expected = { failure: /did not complete/, secret: /answer contained a credential/,
   fallback: /effective model did not match/, empty: /did not complete/, timeout: /timeout or output limit/ };
  for(const [prompt,error] of Object.entries(expected)) {
   fs.rmSync(path.join(folder,'observed.json'),{force:true});
   await assert.rejects(askClaude({...options,prompt}),error);
   const seen=JSON.parse(fs.readFileSync(path.join(folder,'observed.json'),'utf8'));
   assert.equal(seen.prompt,prompt,'the failure must happen after the fixture receives the prompt');
   const saved=fs.readdirSync(options.out).map(name=>fs.readFileSync(path.join(options.out,name),'utf8')).join('');
   assert.ok(!saved.includes(options.key));
  }
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('an EOF-only source read does not complete a source review', async () => {
 const {folder,options}=setup();
 try {
  await assert.rejects(askClaude({...options,calls:1,prompt:'source-guard:eof'}),/read no source/);
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

test('an empty-file-only source read does not complete a source review', async () => {
 const {folder,options}=setup();
 try {
  await assert.rejects(askClaude({...options,calls:1,prompt:'source-guard:emptyfile'}),/read no source/);
 } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

function capturedRunCli(chunks) {
 const source=fs.readFileSync(new URL('./helpers/claude-review.js',import.meta.url),'utf8');
 const start=source.indexOf('function runCli(');
 const end=source.indexOf('export async function askClaude',start);
 assert.ok(start>=0&&end>start);
 const child=new EventEmitter();
 child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
 let killed=false;
 child.kill=()=>{killed=true;child.emit('close',null,'SIGTERM');};
 child.stdin.end=()=>{
  for(const chunk of chunks) {if(killed)break;child.stdout.emit('data',chunk);}
  if(!killed)child.emit('close',0,null);
 };
 const runCli=vm.runInNewContext(source.slice(start,end)+'\nrunCli;',{
  spawn:()=>child,process,Buffer,StringDecoder,TextDecoder,setTimeout,clearTimeout,
 });
 return runCli('fake',[],{},'',1000);
}

test('split stdout UTF8 bytes preserve the exact provider output', async () => {
 const bytes=Buffer.from('left € 🙂 right','utf8');
 const chunks=[bytes.subarray(0,6),bytes.subarray(6,10),bytes.subarray(10)];
 const output=await capturedRunCli(chunks);
 assert.equal(output.stdout,'left € 🙂 right');
});

test('the stdout cap counts multibyte bytes rather than decoded characters', async () => {
 const bytes=Buffer.from('é'.repeat(3*1024*1024),'utf8');
 assert.ok(bytes.length>4*1024*1024);
 await assert.rejects(capturedRunCli([bytes]),/output limit/);
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


test('a CLI that closes stdin before reading a large prompt fails without an unhandled EPIPE', async () => {
 const {folder,options}=setup();
 try {
  fs.writeFileSync(options.cli, `const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('2.1.293'); process.exit(0); }
if(args[0]==='auth') { console.log(JSON.stringify({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'})); process.exit(0); }
process.stdin.destroy(); process.exit(17);`);
  await assert.rejects(askClaude({...options,timeoutMs:15000,prompt:'x'.repeat(1024 * 1024)}), /no valid result/);
  const receipt=JSON.parse(fs.readFileSync(path.join(options.out,'adapter-error.json'),'utf8'));
  assert.match(receipt.error,/no valid result/);
  assert.ok(!JSON.stringify(receipt).includes(options.key));
 } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});
