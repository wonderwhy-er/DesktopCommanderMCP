#!/usr/bin/env node

/**
 * A start beside an older Desktop Commander must read the config that is on
 * disk and write durably. 0.2.46 rewrites config.json whole, with no lock and
 * no temp file (writeConfigToDisk). Own HOME per run.
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

// In a key the defaults also carry: without it a fall back to
// getDefaultConfig() would read as a successful read.
const MARKER = 'dc697-marker-directory';
// Large enough that a non-atomic rewrite has a real window to be caught in.
const PADDING = 'x'.repeat(300 * 1024);
const STORM_MS = 4000;
const READER_ROUNDS = 3;
const READERS_PER_ROUND = 4;
// Longer than one rename and one read budget, far shorter than the ~856ms
// either waits: raise these past that and both cases pass against no fix.
const HELD_WINDOW_MS = 150;
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

/** Waits for the parent's word; without the handshake the rename can beat it. */
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

async function tornWriter() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  await new Promise((resolve) => process.once('message', resolve));

  const out = { type: 'write', error: null };
  try {
    await configManager.setValue('__tornWindowProbe', Date.now());
  } catch (error) {
    out.error = String(error?.message ?? error);
  }
  process.send?.(out);
}

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
 * The guard for the commit. Windows refuses to rename onto an open path, and a
 * read handle is enough. The storm below lands that only in some runs, so it
 * reproduces the report but cannot guard against the defect returning.
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
 * The guard for the read. A mutation reads under the lock before writing, so a
 * neighbour mid-rewrite makes that read fail to parse.
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
  // Control: how many of these would fail without the fix varies run to run,
  // so this count proves nothing on its own -- the two cases above do.
  rmSync(home, { recursive: true, force: true });
}

if (ROLE === 'legacy-writer') await legacyWriter();
else if (ROLE === 'modern-writer') await modernWriter();
else if (ROLE === 'reader') await reader();
else if (ROLE === 'single-write') await singleWrite();
else if (ROLE === 'torn-write') await tornWriter();
else { await heldHandle(); await tornWindow(); await parent(); }
