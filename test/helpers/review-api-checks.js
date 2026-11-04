/** Offline Claude Code fixture exercises the real frozen-source broker and artifact writers. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function reviewCliFixture({ dir, source, head }) {
  const state = path.join(dir, 'claude-state.json');
  const observed = path.join(dir, 'claude-observed.json');
  const cli = path.join(dir, 'fake-claude.mjs');
  const fixture = `import fs from 'node:fs';
const args=process.argv.slice(2); if(args.includes('--version')){console.log('2.1.293 (Claude Code)');process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'}));process.exit(0);}
const mode=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')).mode;
let prompt='';for await(const part of process.stdin)prompt+=part;
const cfg=JSON.parse(args[args.indexOf('--mcp-config')+1]);
let id=0;const rpc=async(method,params)=>{const r=await fetch(cfg.mcpServers.review.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});return(await r.json()).result;};
await rpc('initialize',{protocolVersion:'2025-03-26'});
const tools=(await rpc('tools/list',{})).tools;
const read=await rpc('tools/call',{name:'read_file',arguments:{path:${JSON.stringify('pr/'+source)}}});
const link=await rpc('tools/call',{name:'read_file',arguments:{path:'pr/link'}});
let git;if(mode==='git')git=await rpc('tools/call',{name:'run_shell_command',arguments:{command:${JSON.stringify('git log -1 --format=%P '+head)}}});
const checking=prompt.includes("# Checking the review's real bugs");
const seen=fs.existsSync(${JSON.stringify(observed)})?JSON.parse(fs.readFileSync(${JSON.stringify(observed)},'utf8')):[];
seen.push({args,prompt,tools,read,link,git,checking,envKeys:Object.keys(process.env)});fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(seen));
let answer=checking?{verdicts:[{n:1,holds:mode!=='refute',line:2,quote:'export const two = 2;'}]}:
 mode==='text'||mode==='git'?{summary:'Evidence missing.',findings:[{kind:'not checked',line:2,text:'No own-head result supplied.'}],checked:[{claim:'Adds b.',line:1,evidence:'src/b.ts:1'}]}:
 mode==='clean'?{summary:'Checked.',findings:[]}:{summary:'One bug.',findings:[{kind:'real bug',file:${JSON.stringify('pr/'+source)},line:2,text:'two is 2.'}]};
if(mode==='invalid')answer={summary:'Missing findings.'};
if(mode==='secret')answer={summary:process.env.ANTHROPIC_API_KEY,findings:[]};
console.log(JSON.stringify({type:'result',subtype:mode==='incomplete'?'error_max_turns':'success',is_error:mode==='http',num_turns:1,result:JSON.stringify(answer),modelUsage:{'claude-haiku-5-5':{inputTokens:10,outputTokens:5}}}));`;
  fs.writeFileSync(cli, fixture);
  return { state, observed, cli };
}

export async function reviewApiChecks({ ciReview, dir, repo, base, head, out, api }) {
  const source = fs.existsSync(path.join(repo, 'src/server/a.ts')) ? 'src/server/a.ts' : 'src/a.ts';
  const { state, observed, cli } = reviewCliFixture({ dir, source, head });
  const run = (options = [], env = {}, range = `${base}..${head}`) => ciReview(
    ['run', range, '--repo', repo, '--out', out, ...options],
    { ANTHROPIC_API_KEY: 'local-test-api-key', REVIEW_CLAUDE_CLI: cli, PR: '', ...env }, dir);
  const reset = (mode) => {
    fs.writeFileSync(state, JSON.stringify({ mode }));
    fs.rmSync(observed, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  };
  const observations = () => JSON.parse(fs.readFileSync(observed, 'utf8'));
  const summary = path.join(dir, 'claude-summary.md');
  fs.writeFileSync(summary, '');
  reset('read');
  let done = await run([], { ANTHROPIC_API_KEY: '', GITHUB_STEP_SUMMARY: summary });
  assert.equal(done.code, 1);
  assert.match(done.stderr, /No Anthropic API key/);
  assert.match(fs.readFileSync(summary, 'utf8'), /AI review: not done/);
  assert.ok(!fs.existsSync(observed));

  fs.writeFileSync(path.join(repo, source), 'uncommitted checkout change\n');
  done = await run();
  assert.equal(done.code, 0, done.stderr);
  const reads = observations();
  assert.match(reads[0].read.content[0].text, /export const two = 2/);
  assert.ok(!reads[0].read.content[0].text.includes('uncommitted'));
  assert.equal(reads[0].link.content[0].text, '1: ../../secret');
  assert.ok(reads[0].tools.every((tool) => tool.name !== 'run_shell_command'));
  for (const read of reads) {
    assert.equal(read.args[read.args.indexOf('--model')+1], 'claude-haiku-5-5');
    assert.equal(read.args[read.args.indexOf('--effort')+1], 'medium');
    assert.ok(!read.envKeys.includes('GH_TOKEN') && !read.envKeys.includes('OPENAI_API_KEY'));
  }
  const saved = JSON.parse(fs.readFileSync(path.join(out, 'review.json'), 'utf8'));
  assert.equal(saved.head, head); assert.equal(saved.base, base);
  assert.equal(saved.findings[0].file, source);
  assert.equal(saved.usage.total, 15); assert.equal(saved.usage.requests, null);
  assert.equal(saved.tests, null);
  if (saved.checkUsage) {
    assert.equal(reads.length, 2); assert.equal(saved.checkUsage.total, 15);
    assert.ok(reads[1].checking);
    reset('refute'); done = await run(); assert.equal(done.code, 0, done.stderr);
    const refuted = JSON.parse(fs.readFileSync(path.join(out, 'review.json'), 'utf8'));
    assert.deepEqual(refuted.findings, []); assert.equal(refuted.refuted.length, 1);
  }
  for (const mode of ['http', 'incomplete', 'secret', 'invalid']) {
    reset(mode); done = await run([], { GITHUB_STEP_SUMMARY: summary });
    assert.equal(done.code, 1, `${mode} must fail`);
    assert.ok(!fs.existsSync(path.join(out, 'review.json')));
    const artifacts = fs.readdirSync(out).filter((f) => fs.statSync(path.join(out,f)).isFile()).map((f) => fs.readFileSync(path.join(out,f),'utf8')).join('');
    assert.ok(!`${artifacts}${done.stderr}`.includes('local-test-api-key'));
  }
  reset('text');
  const text = path.join(dir, 'claims.md'); const results = path.join(dir, 'evidence.md');
  fs.writeFileSync(text, 'Adds b.\nAll tests passed.\n'); fs.writeFileSync(results, 'No own-head result supplied.');
  done = await run(['--text', text, '--results', results]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(fs.readFileSync(path.join(out, 'text-check.md'), 'utf8'), /not checked/i);
  assert.ok(observations()[0].prompt.includes('evidence.md'));
  reset('git'); done = await run(['--text', text]); assert.equal(done.code, 0, done.stderr);
  assert.equal(observations()[0].git.content[0].text.trim(), base);
  reset('clean');
  const artifacts = path.join(dir, 'coverage-artifacts');
  fs.mkdirSync(path.join(artifacts, 'results-ubuntu-latest/suite'), { recursive: true });
  fs.mkdirSync(path.join(artifacts, 'coverage-ubuntu-latest'), { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'results-ubuntu-latest/suite/results.json'), JSON.stringify({ files: [{ path: 'test/test-a.js', success: true, skipped: [] }] }));
  fs.writeFileSync(path.join(artifacts, 'coverage-ubuntu-latest/lcov.info'), `SF:/w/r/${source}\nDA:1,1\nDA:2,0\nend_of_record\n`);
  done = await run(['--tests', artifacts]); assert.equal(done.code, 0, done.stderr);
  const coverage = JSON.parse(fs.readFileSync(path.join(out, 'review.json'), 'utf8'));
  assert.deepEqual(coverage.tests.platforms, ['ubuntu-latest']);
  assert.equal(coverage.findings[0].kind, 'not covered');
  reset('clean'); done = await run([], { REVIEW_MAX_PROMPT_TOKENS: '100' });
  assert.equal(done.code, 1); assert.match(done.stderr, /Too big to review/);
  assert.ok(!fs.existsSync(observed));
  for (const range of ['main', '..x', `${base}...${head}`, '-x..y']) {
    done = await run([], {}, range); assert.equal(done.code, 1);
  }
  console.log('✓ Claude Code review: frozen head, API key, pinned model/effort, fail closed, text evidence and read-only git');
}
