/** Trusted runner tools on independently selected product and test commits. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapCopiedScripts } from '../map-copied-scripts.js';
export {verifyExecution,verifyOutputs} from './execution-evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const SHA = /^[a-f0-9]{40}$/;
const tools = [
  'run-ci.js', 'run-all-tests.js', 'repro/run-repro.js', 'integration/run-all-integration-tests.js',
  'docker/run-docker-tests.js', 'helpers/node-test-runner.js', 'helpers/test-env.js',
  'helpers/test-home.js', 'helpers/select-tests.js',
];
const posix = file => file.split(path.sep).join('/');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, data) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(data,null,2)+'\n'); };
export function safeOutput(outDir,sources) {
  const canonical=file=> {
    let ancestor=path.resolve(file); const tail=[];
    while (!fs.existsSync(ancestor)) {tail.unshift(path.basename(ancestor));const parent=path.dirname(ancestor);if(parent===ancestor)throw Error('Output has no existing ancestor');ancestor=parent;}
    const resolved=path.join(fs.realpathSync(ancestor),...tail);
    return process.platform==='win32'?resolved.toLowerCase():resolved;
  };
  const output=canonical(outDir);
  const contains=(parent,child)=> {
    const relative=path.relative(parent,child);
    return !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);
  };
  const refuse=()=>{throw Error('Output cannot replace a source checkout or Git metadata');};
  for (const original of sources) {
    const source=canonical(original);
    if (contains(output,source)) refuse();
    if (contains(source,output)) {
      const relative=path.relative(source,output);
      const tracked=spawnSync('git',['-C',original,'ls-files','--',relative],{encoding:'utf8'});
      if (relative.split(path.sep)[0]==='.git' || tracked.status!==0 || tracked.stdout.trim()) refuse();
    }
    const metadata=spawnSync('git',['-C',original,'rev-parse','--path-format=absolute','--git-dir','--git-common-dir'],{encoding:'utf8'});
    if (metadata.status===0) for (const dir of metadata.stdout.trim().split(/\r?\n/).map(canonical)) {
      if (contains(output,dir) || contains(dir,output)) refuse();
    }
  }
  return path.resolve(outDir);
}
function git(root, ...args) {
  const result = spawnSync('git', ['-C',root,...args], {encoding:'utf8'});
  if (result.status !== 0) throw Error(`git ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Child code receives OS metadata, never repository tokens or runner write channels. */
export function executionEnv(env = process.env) {
  const allowed = /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|TZ|CI|GITHUB_ACTIONS|RUNNER_OS)$/i;
  return {...Object.fromEntries(Object.entries(env).filter(([name])=>allowed.test(name))),
    DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1', DC_FLAG_URL:'http://127.0.0.1:9/'};
}

function identity(root, expected, clean = true) {
  if (!SHA.test(expected ?? '') || git(root,'rev-parse','HEAD') !== expected) throw Error('Checkout identity mismatch');
  if (clean && git(root,'status','--porcelain','--untracked-files=normal')) throw Error('Source checkout is not clean');
  return {head:expected,tree:git(root,'rev-parse','HEAD^{tree}')};
}

function productHashes(root) {
  return Object.fromEntries(git(root,'ls-files').split('\n').filter(file=>file && !file.startsWith('test/') && file!=='tsconfig.coverage.json')
    .map(file=>[file,digest(path.join(root,file))]));
}

/** The selected product determines the coverage inventory, including type-only exclusions. */
export function productSources(root) {
  const ts = require('typescript');
  const found=[];
  const visit = (dir) => {
    if (!fs.existsSync(path.join(root,dir))) return;
    for (const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})) {
      const file=posix(path.join(dir,entry.name));
      if (entry.isSymbolicLink()) throw Error(`Source symlink is not supported: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(file) && !file.endsWith('.d.ts') && !(file.startsWith('vendor/') && /\.test\.(js|mjs|cjs|ts)$/.test(file))) {
        if (/\.tsx?$/.test(file)) {
          const output=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,removeComments:true}}).outputText;
          if (!output.replace(/export\s*\{\s*\};?/g,'').trim()) continue;
        }
        found.push(file);
      }
    }
  };
  visit('src'); visit('vendor/telemetry-contract');
  for (const file of ['setup-claude-server.js','uninstall-claude-server.js','track-installation.js']) if (fs.existsSync(path.join(root,file))) found.push(file);
  if (!found.length) throw Error('Product has no counted source files');
  return found.sort();
}

function coverageFiles(root, expected) {
  const summary=JSON.parse(fs.readFileSync(path.join(root,'coverage/coverage-summary.json')));
  const files=Object.keys(summary).filter(key=>key!=='total').map(key=>posix(path.relative(root,key))).sort();
  if (JSON.stringify(files)!==JSON.stringify(expected) || !summary.total) throw Error('Coverage source inventory mismatch');
  for (const file of ['coverage-final.json','lcov.info']) if (!fs.existsSync(path.join(root,'coverage',file))) throw Error(`Missing coverage ${file}`);
  // Publication happens on current main; old product files may no longer exist there.
  // Product-relative keys combine across runner OS and temporary directory names.
  for (const name of ['coverage-summary.json','coverage-final.json']) {
    const file=path.join(root,'coverage',name);
    const data=JSON.parse(fs.readFileSync(file));
    const normalized={};
    for (const [key,value] of Object.entries(data)) {
      if (key==='total') {normalized.total=value;continue;}
      const relative=posix(path.relative(root,key));
      if (!expected.includes(relative)) throw Error('Coverage source inventory mismatch');
      normalized[relative]=name==='coverage-final.json'?{...value,path:relative}:value;
    }
    if (JSON.stringify(Object.keys(normalized).filter(key=>key!=='total').sort())!==JSON.stringify(expected)) throw Error('Coverage source inventory mismatch');
    write(file,normalized);
  }
  const lcov=path.join(root,'coverage/lcov.info');
  fs.writeFileSync(lcov,fs.readFileSync(lcov,'utf8').replace(/^SF:(.+)$/gm,(_,file)=> {
    const source=file.trim();
    const relative=path.isAbsolute(source)?posix(path.relative(root,source)):source.replaceAll('\\','/');
    if (!expected.includes(relative)) throw Error('LCOV source inventory mismatch');
    return `SF:${relative}`;
  }));
}

function outputManifest(dir) {
  const files=[];
  const walk=(folder)=> {
    if (!fs.existsSync(path.join(dir,folder))) return;
    for (const entry of fs.readdirSync(path.join(dir,folder),{withFileTypes:true})) {
      const relative=posix(path.join(folder,entry.name));
      if (entry.isSymbolicLink()) throw Error(`Output symlink refused: ${relative}`);
      if (entry.isDirectory()) walk(relative);
      else files.push({file:relative,sha256:digest(path.join(dir,relative))});
    }
  };
  walk('test-results'); walk('coverage'); return files;
}

/** Stages disposable execution; selected product sources and original checkouts stay intact. */
export async function runIndependent({root,product,tests,harnessRoot=ROOT,harness,
  outDir=path.join(root,'test-results','independent'),selection='',timed=false,run='local',attempt='1',command}) {
  root=fs.realpathSync(root); harnessRoot=fs.realpathSync(harnessRoot); outDir=safeOutput(outDir,[root,harnessRoot]);
  fs.rmSync(outDir,{recursive:true,force:true}); fs.mkdirSync(outDir,{recursive:true});
  const receipt={product,tests,harness:harness ?? git(harnessRoot,'rev-parse','HEAD'),run:String(run),attempt:String(attempt),phase:'identity',exit:1,outputs:[]};
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dc-ci-')));
  const staged=path.join(parent,'product'); const selected=path.join(parent,'tests');
  const env=executionEnv();
  const invoke=command ?? ((exe,args,cwd,childEnv=env)=>spawnSync(exe,args,{cwd,env:childEnv,stdio:'inherit'}).status ?? 1);
  const globalModules=spawnSync('npm root --global',{shell:true,encoding:'utf8',env}).stdout?.trim();
  const npm=[process.env.npm_execpath,globalModules && path.join(globalModules,'npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].find(file=>file && fs.existsSync(file));
  const step=(phase,exe,args,cwd=staged,childEnv=env)=> {
    receipt.phase=phase; const code=invoke(exe,args,cwd,childEnv);
    if (code!==0) {receipt.exit=code; throw Error(`${phase} exited ${code}`);}
  };
  try {
    for (const sha of [product,tests,receipt.harness]) if (!SHA.test(sha ?? '')) throw Error('Selections require full commit SHAs');
    if (!npm) throw Error('The installed npm CLI could not be located');
    const harnessIdentity=identity(harnessRoot,receipt.harness,Boolean(harness));
    harnessIdentity.dirty=Boolean(git(harnessRoot,'status','--porcelain','--untracked-files=normal'));
    harnessIdentity.tools=Object.fromEntries([...tools,'helpers/independent-ci.js','map-copied-scripts.js','check-coverage-report.js']
      .map(file=>[file,digest(path.join(harnessRoot,'test',file))]));
    git(root,'worktree','add','--detach','-q',staged,product);
    git(root,'worktree','add','--detach','-q',selected,tests);
    receipt.identities={product:identity(staged,product),tests:identity(selected,tests),harness:harnessIdentity};
    const before=productHashes(staged);
    if (!fs.existsSync(path.join(selected,'test'))) throw Error('Selected tests commit has no test directory');
    const pkg=JSON.parse(fs.readFileSync(path.join(staged,'package.json'),'utf8'));
    if (!pkg.scripts?.build) throw Error('Selected product has no build script');
    // Acquire product dependencies independently; install scripts get no repository token.
    step('install',process.execPath,[npm,'ci','--no-audit','--no-fund']);
    step('build',process.execPath,[npm,'run','build']);
    const sources=productSources(staged);
    receipt.sources=sources;
    if (fs.existsSync(path.join(staged,'tsconfig.json'))) step('source maps',process.execPath,[path.join(harnessRoot,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json','--sourceMap','false','--inlineSourceMap','true','--inlineSources','true']);
    mapCopiedScripts({root:staged,log:console.log});
    fs.rmSync(path.join(staged,'test'),{recursive:true,force:true});
    fs.cpSync(path.join(selected,'test'),path.join(staged,'test'),{recursive:true});
    // Runner code comes from the harness, not either selected revision.
    for (const file of tools) {
      const destination=path.join(staged,'test',file);
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      fs.copyFileSync(path.join(harnessRoot,'test',file),destination);
    }
    for (const name of ['timed.txt','excluded.txt']) if (!fs.existsSync(path.join(staged,'test',name))) fs.writeFileSync(path.join(staged,'test',name),'');
    // Tool dependencies remain separate from the product lockfile.
    fs.mkdirSync(path.join(staged,'node_modules'),{recursive:true});
    if (!fs.existsSync(path.join(staged,'node_modules/typescript'))) fs.symlinkSync(path.join(harnessRoot,'node_modules/typescript'),path.join(staged,'node_modules/typescript'),process.platform==='win32'?'junction':'dir');
    const config=path.join(parent,'coverage.json');
    write(config,{all:true,include:sources,exclude:[],extension:['.js','.mjs','.cjs','.ts','.tsx'],
      'exclude-after-remap':true,reporter:['html','lcovonly','json','json-summary','cobertura','text-summary'],
      'reports-dir':path.join(staged,'coverage'),'temp-directory':path.join(staged,'test-results/c8-tmp')});
    // Rebuilding tests need the product's own coverage configuration, generated from its sources.
    write(path.join(staged,'tsconfig.coverage.json'),{extends:'./tsconfig.json',compilerOptions:{sourceMap:false,inlineSourceMap:true,inlineSources:true}});
    fs.copyFileSync(path.join(harnessRoot,'test/map-copied-scripts.js'),path.join(staged,'test/map-copied-scripts.js'));
    fs.copyFileSync(path.join(harnessRoot,'test/check-coverage-report.js'),path.join(staged,'test/check-coverage-report.js'));
    const childEnv={...env,TESTS:selection,REPRO_NPM_CACHE:path.join(parent,'npm-cache')};
    receipt.phase='tests';
    const argv=[path.join(staged,'test/run-ci.js')];
    const args=timed ? argv : [path.join(harnessRoot,'node_modules/c8/bin/c8.js'),'--config',config,process.execPath,...argv];
    const testExit=invoke(process.execPath,args,staged,childEnv);
    receipt.exit=testExit===0?0:1;
    receipt.phase='results';
    if (!fs.existsSync(path.join(staged,'test-results'))) throw Error('No test results were written');
    const reportFiles=[];
    for (const folder of fs.readdirSync(path.join(staged,'test-results'))) {
      const file=path.join(staged,'test-results',folder,'results.json');
      if (!fs.existsSync(file)) continue;
      const report=JSON.parse(fs.readFileSync(file)); reportFiles.push(report);
      if (!Array.isArray(report.files) || (report.summary?.files!==report.files.length)) throw Error('Invalid test result counts');
    }
    if (!reportFiles.some(report=>report.files.length>0)) throw Error('No test file ran');
    if (receipt.exit===0 && reportFiles.some(report=>report.files.some(file=>!file.success))) throw Error('Result failure disagrees with test exit');
    if (!timed) {
      coverageFiles(staged,sources);
      write(path.join(staged,'coverage/run.json'),{head:product,clean:false,product,tests,harness:receipt.harness});
    }
    if (JSON.stringify(productHashes(staged))!==JSON.stringify(before)) throw Error('Product source changed during execution');
    identity(selected,tests); identity(harnessRoot,receipt.harness,Boolean(harness));
    for (const [file,hash] of Object.entries(harnessIdentity.tools)) if (digest(path.join(harnessRoot,'test',file))!==hash) throw Error('Harness changed during execution');
    receipt.phase='complete';
  } catch (error) { receipt.error=error.message; receipt.exit=receipt.exit || 1; console.error(error.message); }
  finally {
    try {
      for (const folder of ['test-results','coverage']) {
        const from=path.join(staged,folder);
        if (fs.existsSync(from)) fs.cpSync(from,path.join(outDir,folder),{recursive:true});
      }
      fs.rmSync(path.join(outDir,'test-results/c8-tmp'),{recursive:true,force:true});
      receipt.outputs=outputManifest(outDir);
    } catch (error) {receipt.error=error.message;receipt.exit=1;receipt.phase='outputs';}
    write(path.join(outDir,'execution.json'),receipt);
    for (const dir of [selected,staged]) spawnSync('git',['-C',root,'worktree','remove','--force',dir],{stdio:'ignore'});
    fs.rmSync(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
  return receipt.exit;
}
