/**
 * First-run onboarding must survive an unavailable feature-flag experiment.
 * A failed initial fetch must not be mistaken for a real A/B control assignment.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.js');

function initOnce(home, clientName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_INDEX], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // Test local first-run independently of the caller's remote shell.
        DC_REMOTE_DEVICE: 'false',
        DC_FLAG_URL: 'http://127.0.0.1:9/unavailable',
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finished = false;
    let stdout = '';
    let stderr = '';
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Timed out initializing MCP: ' + stderr)), 12000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) finish(new Error(JSON.stringify(message.error)));
            else finish();
          }
        } catch { /* Ignore non-protocol logs. */ }
      }
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (!finished) finish(new Error('MCP exited before initialize response: ' + code + ' ' + stderr));
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: clientName, version: 'test' },
      },
    }) + '\n');
  });
}

function seed(home, flags) {
  const dir = path.join(home, '.claude-server-commander');
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    telemetryEnabled: false,
    welcomeOnboardingEligible: true,
    pendingWelcomeOnboarding: true,
  }));
  if (flags) writeFileSync(path.join(dir, 'feature-flags.json'), JSON.stringify({ version: 'test', flags }));
  return configPath;
}

async function testMissingExperimentDeferredAndRecovered() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-welcome-flag-retry-'));
  try {
    const configPath = seed(home);
    await initOnce(home, 'claude-ai');
    let saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.pendingWelcomeOnboarding, true, 'failed flag fetch must retain pending onboarding');
    assert.equal(saved.sawOnboardingPage, undefined, 'no false control assignment on fetch failure');
    assert.equal(saved.abTest_OnboardingPreTool, undefined, 'no A/B assignment without experiment');
    console.log('✓ Missing A/B experiment defers welcome page without consuming it');

    writeFileSync(path.join(path.dirname(configPath), 'feature-flags.json'), JSON.stringify({
      version: 'test',
      flags: {
        welcome_page_enabled: true,
        experiments: { OnboardingPreTool: { variants: [{ name: 'noOnboardingPage', weight: 100 }] } },
      },
    }));
    await initOnce(home, 'claude-ai');
    saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.pendingWelcomeOnboarding, false, 'genuine control assignment must consume pending flag');
    assert.equal(saved.sawOnboardingPage, false, 'control assignment must be preserved');
    assert.equal(saved.abTest_OnboardingPreTool, 'noOnboardingPage');
    console.log('✓ A later successful experiment assignment consumes pending onboarding');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function testRemoteWrapperStillSkips() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-welcome-flag-remote-'));
  try {
    const configPath = seed(home);
    await initOnce(home, 'desktop-commander-client');
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.pendingWelcomeOnboarding, false, 'remote wrapper still skips browser onboarding');
    assert.equal(saved.abTest_OnboardingPreTool, undefined, 'remote wrapper must not assign an A/B variant');
    console.log('✓ Remote wrapper still skips welcome page without waiting for experiment flags');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function testUnknownVariantIsNotControl() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-welcome-invalid-variant-'));
  try {
    const configPath = seed(home, {
      experiments: { OnboardingPreTool: { variants: [{ name: 'unexpectedVariant', weight: 100 }] } },
    });
    await initOnce(home, 'claude-ai');
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(saved.pendingWelcomeOnboarding, true, 'unexpected A/B variant must not discard onboarding');
    assert.equal(saved.sawOnboardingPage, undefined);
    console.log('✓ Unknown A/B variant is deferred rather than silently treated as control');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  await testMissingExperimentDeferredAndRecovered();
  await testUnknownVariantIsNotControl();
  await testRemoteWrapperStillSkips();
}
runIfMain(import.meta.url, main);
