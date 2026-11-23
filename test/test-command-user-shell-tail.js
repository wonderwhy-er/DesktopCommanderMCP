/** Real readers/manager, declared sudo-only settings; no input command is executed. */
import assert from 'node:assert/strict';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const original = configManager.getConfig;
  configManager.getConfig = async () => ({ blockedCommands: ['sudo'] });
  try {
    const cases = [
      ["runuser root -- -c 'sudo ls'", 'blocked'],
      ["su root -- -c 'sudo ls'", 'blocked'],
      ["runuser root -- -c 'echo hi'", 'allowed'],
      ['runuser root -- deploy.sh', 'unseen'],
      ['su root -- deploy.sh', 'unseen'],
      ['runuser root deploy.sh', 'unseen'],
      ['runuser root -s /bin/sh -- deploy.sh', 'unseen'],
      ["runuser root -c 'echo safe' sudo", 'allowed'],
      ["su -c 'echo safe' root -- -c 'sudo ls'", 'allowed'],
      ['runuser -u nobody env sudo ls', 'blocked'],
      ['runuser -u nobody echo sudo', 'allowed'],
      ["runuser -u nobody env '$TOOL'", 'allowed'],
      ['runuser -u nobody env "$TOOL"', 'unseen'],
      ['runuser root -- -s', 'allowed'],
      ['runuser root -- -c "unterminated', 'failed'],
    ];
    for (const [command, verdict] of cases) {
      const answer = await commandManager.checkCommand(command, 'bash');
      assert.equal(answer.verdict, verdict, JSON.stringify({ command, answer }));
      if (verdict === 'blocked') assert.equal(answer.name, 'sudo');
      if (verdict === 'unseen') assert(answer.unseen.length > 0);
      if (verdict === 'failed') assert.match(answer.reason, /unterminated/);
    }
    console.log('PASS: 15 real manager shell-tail/argv/literal/runtime/error controls; no input execution');
    return true;
  } finally {
    configManager.getConfig = original;
  }
}
runIfMain(import.meta.url, runTests);
