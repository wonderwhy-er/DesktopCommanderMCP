/** Only the trusted ripgrep acquisition process receives the read token. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runner from './helpers/independent-ci.js';

for(const [sameVersion,fail] of [[true,false],[false,false],[true,true]]) test(`ripgrep acquisition ${fail?'fails closed':'uses '+(sameVersion?'trusted harness':'official registry for another locked version')}`,()=> {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dc-ripgrep-')));
  const saved=Object.fromEntries(['TMPDIR','TEMP','TMP'].map(name=>[name,process.env[name]]));
  for(const name of Object.keys(saved))process.env[name]=root;
  const product=path.join(root,'product'),harness=path.join(root,'harness'),parent=path.join(root,'run');
  const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data));};
  try {
    const version=sameVersion?'1.17.0':'1.16.0';
    write(path.join(product,'package-lock.json'),{packages:{'node_modules/@vscode/ripgrep':{version}}});
    const trusted=path.join(harness,'node_modules/@vscode/ripgrep');
    write(path.join(trusted,'package.json'),{name:'@vscode/ripgrep',version:'1.17.0'});
    write(path.join(trusted,'lib/postinstall.js'),'trusted');
    const calls=[];
    const command=(exe,args,cwd,env)=> {
      calls.push({exe,args,cwd,env});
      if(args.includes('config'))return {status:0,stdout:'arm64\n'};
      if(args.includes('install')) {
        assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--registry=https://registry.npmjs.org'));
        assert.equal(env.GITHUB_TOKEN,undefined); assert.equal(env.GH_TOKEN,undefined);
        write(path.join(cwd,'node_modules/@vscode/ripgrep/package.json'),{name:'@vscode/ripgrep',version});
        write(path.join(cwd,'node_modules/@vscode/ripgrep/lib/postinstall.js'),'official');
      }
      if(args.includes('--force')) {
        if(fail)return {status:1,stdout:''};
        const archive=path.join(os.tmpdir(),`vscode-ripgrep-cache-${version}`,'ripgrep-fixture.zip');
        write(archive,'archive');write(path.join(cwd,'bin',process.platform==='win32'?'rg.exe':'rg'),'binary');
        return {status:0,stdout:`Downloading to ${archive}\n`};
      }
      return 0;
    };
    assert.equal(typeof runner.prepareRipgrep,'function');
    const prepare=()=>runner.prepareRipgrep({productRoot:product,harnessRoot:harness,parent,npm:'npm-cli.js',
      env:{PATH:'path',GH_TOKEN:'unrelated',GITHUB_OUTPUT:'output'},token:'read-token',command});
    if(fail){assert.throws(prepare,/download exited 1/);return;}
    const result=prepare();
    assert.equal(result.version,version);
    assert.equal(result.arch,'arm64');
    const download=calls.at(-1);
    assert.equal(download.env.GITHUB_TOKEN,'read-token'); assert.equal(download.env.GH_TOKEN,undefined);
    assert.equal(download.env.npm_config_arch,'arm64');
    assert.equal(download.env.GITHUB_OUTPUT,undefined); assert.ok(download.args.includes('--force'));
    assert.ok(!download.args[0].startsWith(product),'no product install script receives the token');
  } finally {
    for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
