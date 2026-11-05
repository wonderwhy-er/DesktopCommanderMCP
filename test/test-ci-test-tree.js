/** Selected test links must not redirect trusted runner-file writes outside staging. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runner from './helpers/independent-ci.js';

for(const atRoot of [false,true]) test(`selected test tree refuses ${atRoot?'root':'nested'} directory links before overlay writes`,()=> {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dc-test-links-')));
  try {
    const outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'node-test-runner.js'),'keep');
    const selected=path.join(dir,'test');
    if(!atRoot)fs.mkdirSync(selected);
    fs.symlinkSync(outside,atRoot?selected:path.join(selected,'helpers'),process.platform==='win32'?'junction':'dir');
    assert.equal(typeof runner.validateTestTree,'function');
    assert.throws(()=>runner.validateTestTree(selected),/symbolic link/);
    assert.equal(fs.readFileSync(path.join(outside,'node-test-runner.js'),'utf8'),'keep');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('regular selected tests and fixtures remain accepted',()=> {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dc-test-regular-')));
  try {
    fs.mkdirSync(path.join(dir,'helpers'));fs.writeFileSync(path.join(dir,'helpers/data.txt'),'fixture');
    assert.equal(typeof runner.validateTestTree,'function');
    assert.doesNotThrow(()=>runner.validateTestTree(dir));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
