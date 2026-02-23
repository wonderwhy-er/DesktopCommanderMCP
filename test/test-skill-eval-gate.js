import assert from 'assert';
import { handleListSkills, handleRunSkill, handleApproveSkillRun } from '../dist/handlers/skills-handlers.js';
import { configManager } from '../dist/config-manager.js';
import { skillRunner } from '../dist/skills/runner.js';

function parseTextPayload(result) {
  const text = result?.content?.[0]?.text || '{}';
  return JSON.parse(text);
}

async function run() {
  const prevEnabled = await configManager.getValue('skillsEnabled');
  const prevDirs = await configManager.getValue('skillsDirectories');
  const prevExecMode = await configManager.getValue('skillExecutionMode');
  const prevEvalGateEnabled = await configManager.getValue('skillExecuteEvalGateEnabled');
  const prevEvalMinPassRate = await configManager.getValue('skillExecuteMinPassRate');
  const prevEvalMinSampleSize = await configManager.getValue('skillExecuteMinSampleSize');

  try {
    skillRunner.resetExecuteEvalStats();
    await configManager.setValue('skillsEnabled', true);
    await configManager.setValue('skillsDirectories', ['/Users/test1/.codex/skills']);
    await configManager.setValue('skillExecutionMode', 'confirm');
    await configManager.setValue('skillExecuteEvalGateEnabled', true);
    await configManager.setValue('skillExecuteMinPassRate', 0.95);
    await configManager.setValue('skillExecuteMinSampleSize', 1);

    const listed = await handleListSkills({ limit: 1 });
    assert.ok(!listed.isError, 'list_skills should succeed when enabled');
    const listPayload = parseTextPayload(listed);
    const skillId = listPayload.skills[0].id;

    const blockedExecute = await handleRunSkill({
      skillId,
      goal: 'should be blocked by eval gate',
      mode: 'execute'
    });
    assert.ok(blockedExecute.isError, 'execute mode should be blocked when eval sample is below threshold');
    assert.strictEqual(blockedExecute?._meta?.reason_code, 'eval_gate_blocked', 'eval gate block should return reason code');

    const planRun = await handleRunSkill({ skillId, goal: 'plan still allowed', mode: 'plan' });
    assert.ok(!planRun.isError, 'plan mode should still be allowed with eval gate enabled');

    await configManager.setValue('skillExecuteEvalGateEnabled', false);

    const executeAllowed = await handleRunSkill({
      skillId,
      goal: 'execute after disabling gate',
      mode: 'execute',
      maxSteps: 2
    });
    assert.ok(!executeAllowed.isError, 'execute mode should be allowed when gate is disabled');
    const executePayload = parseTextPayload(executeAllowed);
    assert.strictEqual(executePayload.state, 'waiting_approval', 'confirm mode should still wait approval');

    const approved = await handleApproveSkillRun({ runId: executePayload.runId });
    assert.ok(!approved.isError, 'approve should succeed when gate is disabled');
  } finally {
    await configManager.setValue('skillsEnabled', prevEnabled ?? false);
    await configManager.setValue('skillsDirectories', prevDirs ?? []);
    await configManager.setValue('skillExecutionMode', prevExecMode ?? 'confirm');
    await configManager.setValue('skillExecuteEvalGateEnabled', prevEvalGateEnabled ?? true);
    await configManager.setValue('skillExecuteMinPassRate', prevEvalMinPassRate ?? 0.95);
    await configManager.setValue('skillExecuteMinSampleSize', prevEvalMinSampleSize ?? 50);
  }

  console.log('test-skill-eval-gate: PASS');
}

run().catch((error) => {
  console.error('test-skill-eval-gate: FAIL', error);
  process.exit(1);
});
