/**
 * Paths the tests put into a command must reach it as written, whatever
 * characters they contain: a Windows user folder such as C:\Users\O'Brien, a
 * temporary folder with a quote or a $ in its name.
 *
 * - psQuote() (test/helpers/powershell.js) gives a PowerShell literal that
 *   PowerShell reads back as the exact text: checked by running PowerShell where
 *   there is one (powershell.exe on Windows, else pwsh).
 * - createStalledReadTarget() (test/helpers/stalled-read.js) makes its FIFO in a
 *   temporary folder whose name has a quote and a $ (macOS/Linux; Windows uses a
 *   named pipe, which has no folder).
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { psQuote } from './helpers/powershell.js';
import { createStalledReadTarget } from './helpers/stalled-read.js';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';

const TEXTS = [
  'C:\\Users\\me\\notes.txt',
  "C:\\Users\\O'Brien\\notes.txt",
  'C:\\Users\\me\\it\u2019s here\\a\u2018b\u201Ac\u201Bd.txt',
  'costs $HOME and `backtick` and "double" quotes',
  '',
];

function findPowerShell() {
  for (const command of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh']) {
    const probe = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8' });
    if (probe.status === 0) return command;
  }
  return null;
}

/** The text PowerShell reads from a literal, as UTF-16 code units (safe from console encodings) */
function readBackInPowerShell(powershell, literal) {
  const script = `$s = ${literal}; ($s.ToCharArray() | ForEach-Object { [int]$_ }) -join ','`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `PowerShell failed on ${literal}: ${result.stderr}`);
  return result.stdout.trim();
}

const codeUnits = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)).join(',');

async function psQuoteGivesTheExactText() {
  assert.strictEqual(psQuote("O'Brien"), "'O''Brien'", 'a single quote must be doubled');
  assert.strictEqual(psQuote('a\u2019b'), "'a\u2019\u2019b'", 'PowerShell reads \u2019 as a single quote: it must be doubled too');
  const powershell = findPowerShell();
  if (!powershell) return skip('psQuote round trip: no PowerShell on this machine');
  for (const text of TEXTS) {
    assert.strictEqual(readBackInPowerShell(powershell, psQuote(text)), codeUnits(text), `PowerShell read ${psQuote(text)} as other text than ${JSON.stringify(text)}`);
  }
}

async function fifoInAFolderWithQuotes() {
  if (process.platform === 'win32') return skip('stalled-read FIFO path: Windows uses a named pipe, no folder');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-command-paths-'));
  const folder = path.join(base, 'a "quote" and $HOME');
  fs.mkdirSync(folder);
  const savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = folder;
  try {
    const target = await createStalledReadTarget();
    try {
      assert.strictEqual(path.dirname(target.path), fs.realpathSync.native(folder), `the FIFO was made at ${target.path}, not in ${folder}`);
      assert(fs.statSync(target.path).isFIFO(), `${target.path} is not a FIFO`);
    } finally {
      target.close();
    }
  } finally {
    if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

export default async function runTests() {
  const failures = [];
  for (const check of [psQuoteGivesTheExactText, fifoInAFolderWithQuotes]) {
    try {
      console.log(`${await check() === SKIPPED ? '- skipped:' : '✓'} ${check.name}`);
    } catch (error) {
      failures.push(check.name);
      console.log(`✗ ${check.name}: ${error.message}`);
    }
  }
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
