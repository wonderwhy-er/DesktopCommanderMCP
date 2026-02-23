import assert from 'assert';
import {
  handleListSkills,
  handleGetSkill,
  handleRunSkill,
  handleApproveSkillRun,
  handleGetSkillRun,
  handleCancelSkillRun
} from '../dist/handlers/skills-handlers.js';
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
    await configManager.setValue('skillExecuteEvalGateEnabled', false);
    await configManager.setValue('skillExecuteMinPassRate', 0.95);
    await configManager.setValue('skillExecuteMinSampleSize', 50);

    const listed = await handleListSkills({ limit: 5 });
    assert.ok(!listed.isError, 'list_skills should succeed when enabled');
    const listPayload = parseTextPayload(listed);
    assert.ok(Array.isArray(listPayload.skills), 'list_skills should return skills array');
    assert.ok(listPayload.skills.length > 0, 'at least one skill should be discovered');

    const skillId = listPayload.skills[0].id;
    const single = await handleGetSkill({ skillId, includeResources: true });
    assert.ok(!single.isError, 'get_skill should succeed for discovered skill');
    const skillPayload = parseTextPayload(single);
    assert.strictEqual(skillPayload.id, skillId, 'get_skill should return requested skill');

    const planned = await handleRunSkill({ skillId, goal: 'inspect repository', mode: 'plan', maxSteps: 6 });
    assert.ok(!planned.isError, 'run_skill plan mode should succeed');
    const planPayload = parseTextPayload(planned);
    assert.strictEqual(planPayload.state, 'completed', 'plan mode should complete immediately');
    assert.ok(planPayload.steps.length >= 2, 'plan should include deterministic steps');

    const strictSchemaResult = await handleRunSkill({
      skillId,
      goal: 'schema strictness check',
      mode: 'plan',
      unexpected_arg: true
    });
    assert.ok(strictSchemaResult.isError, 'run_skill should reject unknown arguments in strict schema mode');

    const executing = await handleRunSkill({ skillId, goal: 'execute workflow', mode: 'execute', maxSteps: 2 });
    assert.ok(!executing.isError, 'run_skill execute should return run object');
    const execPayload = parseTextPayload(executing);
    assert.strictEqual(execPayload.state, 'waiting_approval', 'confirm mode should require approval');
    assert.strictEqual(execPayload.requiresApproval, true, 'run should require approval in confirm mode');
    assert.strictEqual(execPayload.nextAction, 'approve_skill_run', 'next action should request approval');

    const fetchedRun = await handleGetSkillRun({ runId: execPayload.runId });
    assert.ok(!fetchedRun.isError, 'get_skill_run should return pending run');
    const runPayload = parseTextPayload(fetchedRun);
    assert.strictEqual(runPayload.runId, execPayload.runId, 'run IDs should match');

    const approved = await handleApproveSkillRun({ runId: execPayload.runId });
    assert.ok(!approved.isError, 'approve_skill_run should succeed');
    const approvedPayload = parseTextPayload(approved);
    assert.strictEqual(approvedPayload.state, 'completed', 'approved run should complete');
    assert.strictEqual(approvedPayload.executionSummary.passed, true, 'approved run should pass verification');
    assert.ok(Array.isArray(approvedPayload.executionSummary.stepOutcomes), 'step outcomes should be present');

    const executedThenCanceled = await handleRunSkill({ skillId, goal: 'execute then cancel', mode: 'execute', maxSteps: 2 });
    assert.ok(!executedThenCanceled.isError, 'second execute run should be created');
    const pendingForCancel = parseTextPayload(executedThenCanceled);
    const canceled = await handleCancelSkillRun({ runId: pendingForCancel.runId });
    assert.ok(!canceled.isError, 'cancel_skill_run should succeed');
    const canceledPayload = parseTextPayload(canceled);
    assert.strictEqual(canceledPayload.state, 'canceled', 'run should be canceled');

    // Golden-path sample evals: run plan mode for up to 3 discovered skills
    const sampleSkillIds = listPayload.skills.slice(0, 3).map((skill) => skill.id);
    for (const sampleSkillId of sampleSkillIds) {
      const samplePlan = await handleRunSkill({
        skillId: sampleSkillId,
        goal: `golden path evaluation for ${sampleSkillId}`,
        mode: 'plan',
        maxSteps: 5
      });
      assert.ok(!samplePlan.isError, `golden sample should succeed for ${sampleSkillId}`);
      const samplePayload = parseTextPayload(samplePlan);
      assert.strictEqual(samplePayload.state, 'completed', `sample plan should complete for ${sampleSkillId}`);
      assert.ok(samplePayload.steps.length >= 2, `sample plan should include steps for ${sampleSkillId}`);

      const sampleExecute = await handleRunSkill({
        skillId: sampleSkillId,
        goal: `golden execute evaluation for ${sampleSkillId}`,
        mode: 'execute',
        maxSteps: 2
      });
      assert.ok(!sampleExecute.isError, `golden execute should queue for ${sampleSkillId}`);
      const sampleExecutePayload = parseTextPayload(sampleExecute);
      assert.strictEqual(sampleExecutePayload.state, 'waiting_approval', `sample execute should wait approval for ${sampleSkillId}`);

      const sampleApproved = await handleApproveSkillRun({ runId: sampleExecutePayload.runId });
      assert.ok(!sampleApproved.isError, `sample approve should succeed for ${sampleSkillId}`);
      const sampleApprovedPayload = parseTextPayload(sampleApproved);
      assert.strictEqual(sampleApprovedPayload.state, 'completed', `sample execute should complete for ${sampleSkillId}`);
      assert.strictEqual(sampleApprovedPayload.executionSummary.passed, true, `sample execute verification should pass for ${sampleSkillId}`);
    }
  } finally {
    await configManager.setValue('skillsEnabled', prevEnabled ?? false);
    await configManager.setValue('skillsDirectories', prevDirs ?? []);
    await configManager.setValue('skillExecutionMode', prevExecMode ?? 'confirm');
    await configManager.setValue('skillExecuteEvalGateEnabled', prevEvalGateEnabled ?? true);
    await configManager.setValue('skillExecuteMinPassRate', prevEvalMinPassRate ?? 0.95);
    await configManager.setValue('skillExecuteMinSampleSize', prevEvalMinSampleSize ?? 50);
  }

  console.log('test-skills-workflow: PASS');
}

run().catch((error) => {
  console.error('test-skills-workflow: FAIL', error);
  process.exit(1);
});
