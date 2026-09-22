#!/usr/bin/env node

/**
 * DC-697: a controlled reproduction of the pairing the reporter ran — two
 * Desktop Commander builds writing ~/.claude-server-commander/config.json at
 * the same time.
 *
 * They ran 0.2.50 via `npx ... remote` beside 0.2.46 served by Claude Desktop.
 * 0.2.46 rewrites the whole file in place, with no lock and no temp file:
 *
 *   await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
 *   -- v0.2.46:src/config-manager.ts:198
 *
 * The current build writes through a temp file and a rename while holding a
 * cross-process lock, so it cannot tear the file itself. What it cannot do is
 * stop an older build from tearing it, and the issue reported the reader side:
 * a startup that died with -32603 "Unexpected end of JSON input", and a flood
 * of "Failed to reload config".
 *
 * So: run both writers against one config and measure what a starting process
 * sees. Two claims are checked, both about the reader.
 *
 *   1. A process that starts during the storm gets the config that is on disk,
 *      not silently a default one. init() catches a parse failure and falls
 *      back to getDefaultConfig(), which loses allowedDirectories, the block
 *      list and the telemetry choice for the life of that process.
 *   2. A durable write issued during the storm does not throw. That throw is
 *      what reached the client as -32603 through the tools/list handler.
 *
 * Every run gets its own HOME, so the real ~/.claude-server-commander is never
 * touched. Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-config-concurrent-writers.js
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const ROLE = process.env.DC_CONCURRENT_ROLE;

// The marker lives in a key the defaults also carry, so a reader that fell back
// to getDefaultConfig() is distinguishable from one that read the real file.
const MARKER = 'dc697-marker-directory';
// Large enough that a non-atomic rewrite has a real window to be caught in.
const PADDING = 'x'.repeat(300 * 1024);
const STORM_MS = 4000;
const READER_ROUNDS = 3;
const READERS_PER_ROUND = 4;
// Held long enough that a single rename cannot get through, short enough that
// the commit's retry budget (~856ms) covers it several times over.
const HELD_WINDOW_MS = 150;
// Longer than the read budget was when this was written, so the torn file
// outlives it; well inside what a commit already waits out on the write side.
const TORN_WINDOW_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseConfig() {
  return {
    allowedDirectories: [MARKER],
    telemetryEnabled: false,
    welcomeOnboardingEligible: false,
    pendingWelcomeOnboarding: false,
    __padding: PADDING,
  };
}

/** 0.2.46's write: the whole file, in place, no lock and no temp file. */
async function legacyWriter() {
  const { CONFIG_FILE } = await import('../dist/config.js');
  const deadline = Date.now() + STORM_MS;
  let writes = 0;
  while (Date.now() < deadline) {
    const config = baseConfig();
    config.__legacyCounter = writes++;
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  }
  process.send?.({ type: 'done', writes });
}

/** The current build: temp file, rename, cross-process lock. */
async function modernWriter() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  const deadline = Date.now() + STORM_MS;
  let writes = 0;
  while (Date.now() < deadline) {
    await configManager.setValue('__modernCounter', writes++);
  }
  process.send?.({ type: 'done', writes });
}

/**
 * One durable write, on the parent's word. The handshake is what makes the
 * case deterministic: the parent opens its handle only once this process is
 * loaded and ready, so the handle is certainly held when the rename runs.
 */
async function singleWrite() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  await new Promise((resolve) => process.once('message', resolve));

  const out = { type: 'write', error: null, code: null };
  try {
    await configManager.setValue('__heldHandleProbe', Date.now());
  } catch (error) {
    out.error = String(error?.message ?? error);
    out.code = error?.code ?? null;
  }
  process.send?.(out);
}

/** One durable write, for the case that tears the file underneath it. */
async function tornWriter() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  await new Promise((resolve) => process.once('message', resolve));

  const out = { type: 'write', error: null };
  try {
    // What getOrCreateClientId() does on the tools/list path.
    await configManager.setValue('__tornWindowProbe', Date.now());
  } catch (error) {
    out.error = String(error?.message ?? error);
  }
  process.send?.(out);
}

/** A Desktop Commander starting up while the storm runs. */
async function reader() {
  const result = { type: 'read', sawRealConfig: null, mutationError: null };
  try {
    const { configManager } = await import('../dist/config-manager.js');
    const config = await configManager.getConfig();
    result.sawRealConfig = Array.isArray(config.allowedDirectories)
      && config.allowedDirectories.includes(MARKER);
    try {
      // What getOrCreateClientId() does on the tools/list path.
      await configManager.setValue('__readerProbe', Date.now());
    } catch (error) {
      result.mutationError = String(error?.message ?? error);
    }
  } catch (error) {
    result.sawRealConfig = false;
    result.mutationError = String(error?.message ?? error);
  }
  process.send?.(result);
}

function forkRole(role, home) {
  return fork(TEST_FILE, [], {
    env: { ...process.env, HOME: home, USERPROFILE: home, DC_CONCURRENT_ROLE: role },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

function collect(child) {
  return new Promise((resolve) => {
    let last = null;
    child.on('message', (m) => { last = m; });
    child.on('exit', () => resolve(last));
  });
}

/**
 * The same sharing violation as the storm below, without the race.
 *
 * Windows refuses to rename onto a path another process has open, and a plain
 * read handle is enough. The storm reproduces what the reporter ran, but it
 * lands the violation only in some runs -- 0 to 3 starts of 12 here, and whole
 * runs where it never fires -- which makes it a reproduction, not a guard.
 *
 * This is the guard. The handle is opened once the writer is loaded and
 * waiting, so it is certainly held when the rename runs, and it is released
 * HELD_WINDOW_MS later: longer than one rename, far shorter than the commit's
 * retry budget. A commit that does not wait fails immediately; one that waits
 * lands as soon as the handle goes. Both outcomes are deterministic.
 */
async function heldHandle() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc697-held-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));

  const child = forkRole('single-write', home);
  await new Promise((resolve) => {
    child.on('message', function onReady(m) {
      if (m?.type === 'ready') { child.off('message', onReady); resolve(); }
    });
  });

  const handle = await fs.open(configPath, 'r');
  let closed = false;
  const release = async () => { if (!closed) { closed = true; await handle.close().catch(() => {}); } };
  const timer = setTimeout(() => void release(), HELD_WINDOW_MS);

  child.send({ type: 'go' });
  const result = await collect(child);
  clearTimeout(timer);
  await release();

  assert.ok(result, 'the writing child should report back');
  assert.equal(result.error, null,
    `a durable write must wait out another process holding config.json open, got ${result.code}: ${result.error}`);
  console.log(`✓ a durable write commits after a ${HELD_WINDOW_MS}ms handle on config.json goes away`);
  rmSync(home, { recursive: true, force: true });
}

/**
 * The other half of the same -32603, on the read side.
 *
 * A mutation reads the file under the lock before writing it, so an older
 * build caught mid-rewrite makes that read fail to parse. The commit waits a
 * sharing violation out for ~856ms; the read gave up in ~40ms, and the
 * SyntaxError left setValue for the caller -- "Unexpected end of JSON input",
 * the string in the title of #697.
 *
 * Deterministic in both directions, like the case above: the file is torn only
 * once the writer is loaded and waiting, and healed TORN_WINDOW_MS later.
 */
async function tornWindow() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc697-torn-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  const whole = JSON.stringify(baseConfig(), null, 2);
  writeFileSync(configPath, whole);

  const child = forkRole('torn-write', home);
  await new Promise((resolve) => {
    child.on('message', function onReady(m) {
      if (m?.type === 'ready') { child.off('message', onReady); resolve(); }
    });
  });

  writeFileSync(configPath, whole.slice(0, Math.floor(whole.length / 2)));
  const heal = setTimeout(() => writeFileSync(configPath, whole), TORN_WINDOW_MS);

  child.send({ type: 'go' });
  const result = await collect(child);
  clearTimeout(heal);
  writeFileSync(configPath, whole);

  assert.ok(result, 'the writing child should report back');
  assert.equal(result.error, null,
    `a durable write must outlast a ${TORN_WINDOW_MS}ms torn file, got ${result.error}`);
  console.log(`✓ a durable write survives a ${TORN_WINDOW_MS}ms torn config.json`);
  rmSync(home, { recursive: true, force: true });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc697-concurrent-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));

  const writers = [forkRole('legacy-writer', home), forkRole('modern-writer', home)];
  const writerDone = Promise.all(writers.map(collect));

  const samples = [];
  try {
    for (let round = 0; round < READER_ROUNDS; round++) {
      const readers = Array.from({ length: READERS_PER_ROUND }, () => forkRole('reader', home));
      samples.push(...(await Promise.all(readers.map(collect))));
      await sleep(50);
    }
    await writerDone;
  } finally {
    for (const w of writers) w.kill('SIGTERM');
  }

  const answered = samples.filter(Boolean);
  assert.ok(answered.length >= READER_ROUNDS * READERS_PER_ROUND - 1,
    `readers should report back, got ${answered.length} of ${READER_ROUNDS * READERS_PER_ROUND}`);

  const fellBackToDefaults = answered.filter((s) => s.sawRealConfig !== true);
  const mutationsThrew = answered.filter((s) => s.mutationError);

  assert.equal(fellBackToDefaults.length, 0,
    `${fellBackToDefaults.length} of ${answered.length} starts silently replaced the on-disk config with defaults`);
  assert.equal(mutationsThrew.length, 0,
    `${mutationsThrew.length} of ${answered.length} durable writes threw: ${mutationsThrew.map((s) => s.mutationError).join(' | ')}`);

  console.log(`✓ ${answered.length} starts during a 0.2.46-style storm read the real config and wrote durably`);
  // How many of them would have failed without the fix varies run to run; the
  // case above is the one that fails every time.
  rmSync(home, { recursive: true, force: true });
}

if (ROLE === 'legacy-writer') await legacyWriter();
else if (ROLE === 'modern-writer') await modernWriter();
else if (ROLE === 'reader') await reader();
else if (ROLE === 'single-write') await singleWrite();
else if (ROLE === 'torn-write') await tornWriter();
else { await heldHandle(); await tornWindow(); await parent(); }
