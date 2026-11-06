/** Fixed native argument oracles only; no reported executable is launched. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isTestHome } from './helpers/test-env.js';

assert.ok(isTestHome(), 'run through the isolated test runner');
const { readPosixCommands } = await import('../dist/utils/posix-commands.js');
const { withStartedPrograms } = await import('../dist/utils/command-wrappers.js');
const { posixBraceSemantics } = await import('../dist/utils/posix-shell-capabilities.js');

test('Path-only Windows launch environment captures a nonstandard endpoint without executing it',
  { skip: process.platform !== 'win32' }, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-posix-path-only-'));
    try {
      const nativeFolder = path.join(folder, 'native');
      fs.mkdirSync(nativeFolder);
      const endpoint = path.join(nativeFolder, 'bash.exe');
      // The version transport is stubbed before import: this header fixture is NEVER executed.
      fs.writeFileSync(endpoint, Buffer.from('4d5a0000', 'hex'));
      const moduleUrl = new URL('../dist/utils/posix-shell-capabilities.js', import.meta.url).href;
      const code = `import assert from 'node:assert/strict';
        import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
        import fs from 'node:fs';
        for (const name of Object.keys(process.env)) if (name.toLowerCase() === 'path') delete process.env[name];
        process.env.Path = ${JSON.stringify(nativeFolder)};
        assert.equal(process.env.PATH, process.env.Path, 'real Windows process.env is case insensitive');
        assert.deepEqual(Object.keys(process.env).filter(name => name.toLowerCase() === 'path'), ['Path']);
        const queries = [];
        childProcess.execFile = (file, args, options, callback) => {
          queries.push(file); assert.deepEqual(args, ['--version']);
          assert.equal(file.toLowerCase(), fs.realpathSync(${JSON.stringify(endpoint)}).toLowerCase());
          assert.deepEqual(Object.keys(options.env).filter(name => name.toLowerCase() === 'path'), ['PATH']);
          assert.equal(options.env.PATH, process.env.PATH);
          callback(null, 'GNU bash, version 3.2.57\\n');
        };
        syncBuiltinESMExports();
        const { posixBraceSemantics: capability } = await import(${JSON.stringify(moduleUrl)});
        assert.equal(await capability(${JSON.stringify(endpoint)}), 'bash3');
        assert.equal(await capability('bash.exe'), 'bash3');
        assert.equal(queries.length, 1, 'one cached mocked query, no native/custom process execution');`;
      const answer = spawnSync(process.execPath, ['--input-type=module', '-e', code],
        { cwd: folder, encoding: 'utf8', timeout: 5000, env: { ...process.env } });
      assert.equal(answer.status, 0, answer.stderr);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

test('named brace options select one semantics and preserve the default vector', async () => {
  const { braceWords, unquotedChars } = await import('../dist/utils/brace-expansion.js');
  const chars = unquotedChars('python{03..04}');
  assert.deepEqual(braceWords(chars), ['python03', 'python04']);
  assert.deepEqual(braceWords(chars, { semantics: 'bash3' }), ['python3', 'python4']);
  assert.deepEqual(braceWords(unquotedChars('python{2..3..-1}'), { semantics: 'zsh' }), ['python3', 'python2']);
});

test('unsupported endpoints keep every legacy field and existing static block candidate', async () => {
  for (const input of ['python{03..04}', 'python{2..3..-1}', 'python{3..2..-1}',
    'env python{3..2..-1}', 'echo {sudo,ls}', '{"",sudo}', '{$X,sudo} id', 'sudo {1..1001}']) {
    const legacy = await readPosixCommands(input);
    for (const shell of ['custom-unknown-shell', '/not-installed/bash', './late/bash']) {
      assert.deepEqual(await readPosixCommands(input, shell), legacy, `${shell}: ${input}`);
    }
  }
});

test('capability capture rejects scripts and late aliases, anchors PATH and never reads profiles',
  { skip: !fs.existsSync('/bin/bash') }, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-posix-native-'));
    const moduleUrl = new URL('../dist/utils/posix-shell-capabilities.js', import.meta.url).href;
    const readingUrl = new URL('../dist/utils/posix-commands.js', import.meta.url).href;
    try {
      for (const name of ['bin', 'fake', 'other', 'profiles']) fs.mkdirSync(path.join(folder, name));
      const sentinel = path.join(folder, 'executed');
      const script = `#!/bin/sh\nprintf bad > '${sentinel}'\necho 'GNU bash, version 3.2.57'\n`;
      fs.writeFileSync(path.join(folder, 'fake', 'bash'), script, { mode: 0o700 });
      fs.symlinkSync(path.join(folder, 'fake', 'bash'), path.join(folder, 'fake', 'zsh'));
      fs.symlinkSync('/bin/bash', path.join(folder, 'bin', 'bash'));
      fs.writeFileSync(path.join(folder, 'profiles', '.zshenv'), script);
      fs.writeFileSync(path.join(folder, 'startup'), script);
      const run = (launchPath, body) => {
        const code = `import assert from 'node:assert/strict'; import fs from 'node:fs';
          import path from 'node:path';
          const { posixBraceSemantics: capability } = await import(${JSON.stringify(moduleUrl)});
          const { readPosixCommands: read } = await import(${JSON.stringify(readingUrl)});
          ${body}
          assert.equal(fs.existsSync(${JSON.stringify(sentinel)}), false, 'no fake/startup execution');`;
        const answer = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
          cwd: folder, encoding: 'utf8', timeout: 5000,
          env: { ...process.env, PATH: launchPath, BASH_ENV: path.join(folder, 'startup'),
            ENV: path.join(folder, 'startup'), ZDOTDIR: path.join(folder, 'profiles') },
        });
        assert.equal(answer.status, 0, answer.stderr);
      };
      run('fake', `assert.equal(await capability('bash'), undefined);
        assert.equal(await capability('zsh'), undefined);
        assert.equal(await capability(${JSON.stringify(path.join(folder, 'fake', 'bash'))}), undefined);
        assert.deepEqual(await read('python{3..2..-1}', 'bash'), await read('python{3..2..-1}'));`);
      run('bin', `const first = capability('/bin/bash'); assert.strictEqual(capability('/bin/bash'), first);
        const expected = await first; assert.notEqual(expected, undefined);
        if (fs.existsSync('/bin/zsh')) assert.equal(await capability('/bin/zsh'), 'zsh');
        process.chdir('other'); process.env.PATH = ${JSON.stringify(path.join(folder, 'fake'))};
        assert.equal(await capability('bash'), expected);
        assert.equal(await capability('bin/bash'), expected);
        fs.symlinkSync('/bin/bash', '../late-bash');
        assert.equal(await capability(${JSON.stringify(path.join(folder, 'late-bash'))}), undefined);
        assert.equal(await capability(${JSON.stringify(path.join(folder, 'fake', 'bash'))}), undefined);
        assert.equal(await capability('/bin/bash'), expected);`);
      fs.copyFileSync('/bin/bash', path.join(folder, 'bin', 'bash-copy'));
      fs.unlinkSync(path.join(folder, 'bin', 'bash'));
      fs.renameSync(path.join(folder, 'bin', 'bash-copy'), path.join(folder, 'bin', 'bash'));
      fs.chmodSync(path.join(folder, 'bin', 'bash'), 0o700);
      run('bin', `fs.unlinkSync('bin/bash'); assert.equal(await capability('bash'), undefined);`);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

test('existing consumer blocks the reported native programs after the H3 adapter seam', async () => {
  const { commandManager } = await import('../dist/command-manager.js');
  const { configManager } = await import('../dist/config-manager.js');
  const previous = (await configManager.getConfig()).blockedCommands;
  const original = commandManager.readCommands;
  try {
    await configManager.setValue('blockedCommands', ['python3']);
    // Model ONLY H3's pending internal seam; the production manager is not edited by this owner.
    commandManager.readCommands = (command, shell) => readPosixCommands(command, shell);
    for (const shell of ['/bin/bash', '/bin/zsh'].filter((file) => fs.existsSync(file))) {
      const semantics = await posixBraceSemantics(shell);
      let input = 'python{3..4}';
      if (semantics === 'zsh') input = 'python{2..3..-1}';
      if (semantics === 'bash3') input = 'python{03..04}';
      for (const command of [input, `env ${input}`]) {
        assert.deepEqual(await commandManager.checkCommand(command, shell),
          { verdict: 'blocked', name: 'python3' }, `${shell}: ${command}`);
      }
      assert.equal((await commandManager.checkCommand(`echo ${input}`, shell)).verdict, 'allowed');
      assert.equal((await commandManager.checkCommand(`"${input}"`, shell)).verdict, 'allowed');
      if (semantics === 'legacy') {
        assert.equal((await commandManager.checkCommand('python{03..04}', shell)).verdict, 'allowed',
          'modern Bash must not gain a false refusal from the Bash3 reading');
      }
      if (semantics === 'bash3' || semantics === 'zsh') {
        assert.equal((await commandManager.checkCommand('python{3..2..-1}', shell)).verdict, 'allowed',
          'known native semantics must not keep an inactive legacy program as a false refusal');
      }
    }
    assert.deepEqual(await commandManager.checkCommand('python{3..2..-1}', '/unsupported/bash'),
      { verdict: 'blocked', name: 'python3' }, 'unknown capability retains the old block');
  } finally {
    commandManager.readCommands = original;
    await configManager.setValue('blockedCommands', previous);
  }
});

for (const shell of ['/bin/bash', '/bin/zsh']) {
  test(`fixed native range vectors match ${shell}`, { skip: !fs.existsSync(shell) }, async () => {
    for (const input of ['python{03..04}', 'python{2..3..-1}', 'python{3..2..-1}',
      'env python{03..04}', 'env python{2..3..-1}', 'echo python{03..04}', '"python{03..04}"',
      'x{-03..-01}', 'x{+03..+04}', 'x{3..1..0}', 'x{1..3..+1}', 'x{a..c..-1}', 'x{a..c..2}',
      'x{03..-01}', 'x{-03..01}', 'x{1..03}', 'x{a..c}', 'x{Z..a}']) {
      const flags = shell === '/bin/bash' ? ['--noprofile', '--norc'] : ['-f'];
      const oracle = spawnSync(shell, [...flags, '-c', `set -- ${input}; builtin printf '%s\\0' "$@"`],
        { encoding: 'utf8', timeout: 3000 });
      assert.equal(oracle.status, 0, oracle.stderr);
      const words = oracle.stdout.split('\0').slice(0, -1);
      const reading = await readPosixCommands(input, shell);
      assert.equal(reading.parseError, undefined, input);
      assert.deepEqual(reading.commands[0].words, words, `${shell}: ${input}`);
      assert.equal(reading.commands.length, 1, 'one actual vector, no union');
      const programs = withStartedPrograms(reading.commands, shell).map((command) => command.name);
      const executable = words[0] === 'env' ? words[1] : words[0];
      assert.equal(programs.includes('python3'), executable === 'python3', input);
    }
  });
}
