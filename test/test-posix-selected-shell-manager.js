/** Actual manager wiring; Python and selected caller programs are never executed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { readPosixCommands } from '../dist/utils/posix-commands.js';
import { posixBraceSemantics } from '../dist/utils/posix-shell-capabilities.js';
import { createTempDir, isTestHome } from './helpers/test-env.js';

async function withBlocked(names, check) {
  assert.ok(isTestHome(), 'Use the standard isolated test home');
  const original = configManager.getConfig;
  configManager.getConfig = async () => ({ blockedCommands: names });
  try { return await check(); } finally { configManager.getConfig = original; }
}
const nativePosix = { skip: process.platform === 'win32' ? 'Requires fixed native POSIX endpoints' : false };

test('real manager selects Bash3.2 argv without a union', nativePosix, async (t) => {
  if (await posixBraceSemantics('/bin/bash') !== 'bash3') return t.skip('Native Bash3.2 unavailable');
  await withBlocked(['python3'], async () => {
    for (const text of ['python{03..04}', 'env python{03..04}']) {
      assert.deepEqual(await commandManager.checkCommand(text, '/bin/bash'), { verdict:'blocked', name:'python3' });
    }
    assert.deepEqual(await commandManager.checkCommand('echo python{03..04}', '/bin/bash'), { verdict:'allowed' });
    assert.deepEqual(await commandManager.checkCommand("'python{03..04}'", '/bin/bash'), { verdict:'allowed' });
  });
  await withBlocked(['python2'], async () => {
    assert.deepEqual(await commandManager.checkCommand('python{2..3..-1}', '/bin/bash'), { verdict:'allowed' });
  });
});

test('real manager selects Zsh5.9 argv and retains argument roles', nativePosix, async (t) => {
  if (await posixBraceSemantics('/bin/zsh') !== 'zsh') return t.skip('Native Zsh5.9 unavailable');
  await withBlocked(['python3'], async () => {
    for (const text of ['python{2..3..-1}', 'env python{2..3..-1}']) {
      assert.deepEqual(await commandManager.checkCommand(text, '/bin/zsh'), { verdict:'blocked', name:'python3' });
    }
    assert.deepEqual(await commandManager.checkCommand('python{3..2..-1}', '/bin/zsh'), { verdict:'allowed' });
    assert.deepEqual(await commandManager.checkCommand('echo python{2..3..-1}', '/bin/zsh'), { verdict:'allowed' });
  });
});

test('unsupported selection preserves complete legacy readings and static blocks', async () => {
  const root = createTempDir('dc-posix-manager-unsupported-');
  const fake = path.join(root, 'bash'), marker = path.join(root, 'executed');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf wrong > '${marker}'\n`, { mode:0o700 });
  try {
    assert.deepEqual(await commandManager.readCommands('env python{03..04}', fake),
      await readPosixCommands('env python{03..04}'));
    await withBlocked(['python3'], async () => {
      assert.deepEqual(await commandManager.checkCommand('python{3..3}', fake), { verdict:'blocked', name:'python3' });
    });
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('actual late relative-PATH endpoint is not the captured native launch alias', nativePosix, async (t) => {
  if (await posixBraceSemantics('/bin/bash') !== 'bash3') return t.skip('Native Bash3.2 unavailable');
  const root = createTempDir('dc-posix-manager-launch-');
  const urls = Object.fromEntries(['command-manager','config-manager','utils/posix-commands',
    'utils/posix-shell-capabilities'].map(name => [name, new URL(`../dist/${name}.js`, import.meta.url).href]));
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
    const root=${JSON.stringify(root)}, urls=${JSON.stringify(urls)};
    const launch=path.join(root,'launch'), later=path.join(root,'later');
    fs.mkdirSync(path.join(launch,'bin'),{recursive:true}); fs.mkdirSync(path.join(later,'bin'),{recursive:true});
    fs.symlinkSync('/bin/bash',path.join(launch,'bin','bash'));
    const marker=path.join(root,'caller-executed');
    fs.writeFileSync(path.join(later,'bin','bash'),'#!/bin/sh\\nprintf wrong > "'+marker+'"\\n',{mode:0o700});
    process.chdir(launch); process.env.PATH='bin:/usr/bin:/bin';
    const {commandManager}=await import(urls['command-manager']);
    const {configManager}=await import(urls['config-manager']);
    const {readPosixCommands}=await import(urls['utils/posix-commands']);
    const {posixBraceSemantics}=await import(urls['utils/posix-shell-capabilities']);
    configManager.getConfig=async()=>({blockedCommands:['python3']});
    assert.equal((await commandManager.readCommands('python{03..04}','bash')).commands[0].name,'python3');
    process.chdir(later);
    assert.equal(await posixBraceSemantics('bash'),'bash3','Launch alias remains frozen');
    assert.deepEqual(await commandManager.readCommands('python{03..04}','bash'),await readPosixCommands('python{03..04}'));
    assert.deepEqual(await commandManager.checkCommand('python{3..3}','bash'),{verdict:'blocked',name:'python3'});
    assert.equal(fs.existsSync(marker),false);
    console.log('PASS actual selected endpoint differs from anchored launch alias; no caller execution');
  `;
  try {
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
      encoding:'utf8',timeout:15000,env:{...process.env,DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1'},
    });
    assert.equal(child.status,0,child.stderr||child.stdout);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
