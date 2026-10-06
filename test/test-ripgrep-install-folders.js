/**
 * When neither the bundled ripgrep (@vscode/ripgrep) nor one on PATH is there,
 * getRipgrepPath() looks in ripgrep's usual install folders. On Windows those
 * are under Program Files, which Windows doesn't always put on C:, so the
 * folders must come from Windows' own settings (%ProgramFiles%,
 * %ProgramFiles(x86)%); with them unset, the C: defaults.
 *
 * A copy of the resolver's two built files runs from a temporary folder with no
 * node_modules, so the bundled ripgrep can't load, with PATH empty, so only the
 * install folders are left. It runs in this process: Windows sets ProgramFiles
 * itself for every new process, so a child can't be given another one. A
 * stand-in rg.exe in a temporary "Program Files" must be found.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const DIST_UTILS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'utils');
/** Where the old code looked, in order: what it finds with the real settings on this machine */
const C_DRIVE_FOLDERS = ['C:\\Program Files\\Ripgrep\\rg.exe', 'C:\\Program Files (x86)\\Ripgrep\\rg.exe'];
const NOT_FOUND = 'ERROR: ripgrep binary not found';
const SETTINGS = ['PATH', 'ProgramFiles', 'ProgramFiles(x86)'];

/** getRipgrepPath()'s answer with these settings (undefined: unset): a path, or "ERROR: …" */
async function resolveWith(resolver, settings) {
  const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
  const set = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  try {
    for (const name of SETTINGS) set(name, settings[name]);
    resolver.clearRipgrepCache();
    return await resolver.getRipgrepPath();
  } catch (error) {
    return `ERROR: ${error.message.split('.')[0]}`;
  } finally {
    for (const name of SETTINGS) set(name, saved[name]);
    resolver.clearRipgrepCache();
  }
}

/** A folder holding a stand-in Ripgrep\rg.exe (only its existence is checked) */
function programFilesWithRipgrep(dir) {
  fs.mkdirSync(path.join(dir, 'Ripgrep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Ripgrep', 'rg.exe'), '');
  return dir;
}

export default async function runTests() {
  if (process.platform !== 'win32') {
    return skip('ripgrep install folders under %ProgramFiles%: Windows only');
  }
  const dir = createTempDir('dc-ripgrep-folders-');
  try {
    // The resolver without node_modules: import('@vscode/ripgrep') fails there
    const copy = path.join(dir, 'resolver');
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, 'package.json'), '{ "type": "module" }');
    for (const file of ['ripgrep-resolver.js', 'shell.js']) fs.copyFileSync(path.join(DIST_UTILS, file), path.join(copy, file));
    fs.writeFileSync(path.join(copy, 'probe.js'), "export default () => import('@vscode/ripgrep').then(() => true, () => false);");
    if (await (await import(pathToFileURL(path.join(copy, 'probe.js')).href)).default()) {
      return skip('ripgrep install folders: a node_modules above the temporary folder provides @vscode/ripgrep');
    }
    const resolver = await import(pathToFileURL(path.join(copy, 'ripgrep-resolver.js')).href);
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);

    const programFiles = programFilesWithRipgrep(path.join(dir, 'Program Files'));
    let found = await resolveWith(resolver, { PATH: '', ProgramFiles: programFiles, 'ProgramFiles(x86)': empty });
    assert.strictEqual(found, path.join(programFiles, 'Ripgrep', 'rg.exe'),
      'ripgrep in %ProgramFiles%\\Ripgrep (Program Files not on C:) should be found');

    const programFilesX86 = programFilesWithRipgrep(path.join(dir, 'Program Files (x86)'));
    found = await resolveWith(resolver, { PATH: '', ProgramFiles: empty, 'ProgramFiles(x86)': programFilesX86 });
    assert.strictEqual(found, path.join(programFilesX86, 'Ripgrep', 'rg.exe'),
      'ripgrep in %ProgramFiles(x86)%\\Ripgrep should be found');

    // With the real settings, or none, the answer is what the C: list gives on this machine
    const expected = C_DRIVE_FOLDERS.find((file) => fs.existsSync(file)) ?? NOT_FOUND;
    const real = { PATH: '', ProgramFiles: process.env.ProgramFiles, 'ProgramFiles(x86)': process.env['ProgramFiles(x86)'] };
    assert.strictEqual(await resolveWith(resolver, real), expected, 'with the real %ProgramFiles% nothing should change');
    assert.strictEqual(await resolveWith(resolver, { PATH: '' }), expected, 'with %ProgramFiles% unset, the C: folders should be used');
    console.log('✓ ripgrep is found under %ProgramFiles% and %ProgramFiles(x86)%, wherever they are');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

runIfMain(import.meta.url, runTests);
