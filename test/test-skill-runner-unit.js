import assert from 'assert';
import {
  buildDeterministicPlan,
  isSafeCommand,
  isPathWithinRoot,
  SkillRunner
} from '../dist/skills/runner.js';

function makeSkill(id = 'unit-skill') {
  return {
    id,
    name: id,
    description: 'unit test skill',
    path: '/tmp/unit-skill',
    tags: [],
    resources: {
      scripts: [],
      references: [],
      assets: []
    }
  };
}

async function run() {
  const skill = makeSkill();
  const planA = buildDeterministicPlan(skill, 'analyze repo', 4);
  const planB = buildDeterministicPlan(skill, 'analyze repo', 4);
  assert.deepStrictEqual(planA, planB, 'planner should be deterministic for same inputs');

  assert.strictEqual(isSafeCommand('pwd').safe, true, 'pwd should be allowlisted');
  assert.strictEqual(isSafeCommand('ls -la').safe, true, 'ls should be allowlisted');
  assert.strictEqual(isSafeCommand('rm -rf /').safe, false, 'rm should be blocked');
  assert.strictEqual(isSafeCommand('pwd; whoami').safe, false, 'operators should be blocked');

  assert.strictEqual(isPathWithinRoot('/tmp/a/b.txt', '/tmp/a'), true, 'path in root should pass');
  assert.strictEqual(isPathWithinRoot('/tmp/other/b.txt', '/tmp/a'), false, 'path outside root should fail');

  const runner = new SkillRunner();
  const planRun = await runner.runSkill(skill, {
    mode: 'plan',
    goal: 'only plan',
    maxSteps: 3,
    executionMode: 'confirm'
  });
  assert.strictEqual(planRun.state, 'completed', 'plan mode should complete');

  const approvedInvalid = await runner.approveRun(planRun.runId);
  assert.ok(approvedInvalid, 'approveRun should return run object for existing run');
  assert.strictEqual(approvedInvalid.state, 'completed', 'invalid approve transition should not alter completed state');
  assert.ok(approvedInvalid.failures.length > 0, 'invalid transition should record failure');

  console.log('test-skill-runner-unit: PASS');
}

run().catch((error) => {
  console.error('test-skill-runner-unit: FAIL', error);
  process.exit(1);
});
