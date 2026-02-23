import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SkillRunner } from '../dist/skills/runner.js';

async function makeTempSkill() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-runner-'));
  const skillDir = path.join(baseDir, 'demo-skill');
  const scriptsDir = path.join(skillDir, 'scripts');
  await fs.mkdir(scriptsDir, { recursive: true });

  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: demo-skill\ndescription: Demo skill\n---\n\nRun tests.\n`);
  await fs.writeFile(
    path.join(scriptsDir, 'slow.js'),
    `setTimeout(() => { console.log('slow script complete'); process.exit(0); }, 5000);\n`
  );

  return {
    baseDir,
    skill: {
      id: 'demo-skill',
      name: 'demo-skill',
      description: 'Demo skill',
      path: skillDir,
      tags: ['scripts'],
      resources: {
        scripts: ['slow.js'],
        references: [],
        assets: []
      }
    }
  };
}

async function run() {
  const { baseDir, skill } = await makeTempSkill();
  const runner = new SkillRunner();

  try {
    const blockedRun = await runner.runSkill(skill, {
      mode: 'execute',
      goal: 'run outside cwd guardrail',
      cwd: '/tmp',
      maxSteps: 4,
      executionMode: 'auto_safe'
    });

    assert.strictEqual(blockedRun.state, 'failed', 'script execution should fail when cwd escapes skill root');
    assert.ok(
      blockedRun.executionSummary.stepOutcomes.some((outcome) => outcome.reasonCode === 'script_cwd_outside_skill'),
      'runner should report script_cwd_outside_skill reason code'
    );

    const pending = await runner.runSkill(skill, {
      mode: 'execute',
      goal: 'cancel while executing script',
      cwd: skill.path,
      maxSteps: 4,
      executionMode: 'confirm'
    });
    assert.strictEqual(pending.state, 'waiting_approval', 'confirm mode should pause for approval');

    const startedAt = Date.now();
    const approvalPromise = runner.approveRun(pending.runId);
    setTimeout(() => {
      runner.cancelRun(pending.runId);
    }, 400);

    const approvedRun = await approvalPromise;
    assert.ok(approvedRun, 'approveRun should return a run object');
    assert.strictEqual(approvedRun.state, 'canceled', 'run should be canceled during active execution');

    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 4500, 'cancel should stop active process before full script runtime');
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }

  console.log('test-skill-runner-guardrails: PASS');
}

run().catch((error) => {
  console.error('test-skill-runner-guardrails: FAIL', error);
  process.exit(1);
});
