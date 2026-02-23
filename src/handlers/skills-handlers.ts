import { ServerResult } from '../types.js';
import { configManager } from '../config-manager.js';
import {
  ListSkillsArgsSchema,
  GetSkillArgsSchema,
  RunSkillArgsSchema,
  GetSkillRunArgsSchema,
  CancelSkillRunArgsSchema,
  ApproveSkillRunArgsSchema
} from '../tools/schemas.js';
import { skillRegistry } from '../skills/registry.js';
import { skillRunner } from '../skills/runner.js';
import { capture } from '../utils/capture.js';
import { normalizeSkillRuntimeConfig } from '../skills/runtime-config.js';
import type { SkillReasonCode } from '../skills/types.js';

function jsonResponse(payload: unknown): ServerResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  };
}

function errorResponse(message: string, reasonCode: SkillReasonCode, extraMeta?: Record<string, unknown>): ServerResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    _meta: {
      reason_code: reasonCode,
      ...(extraMeta || {})
    }
  };
}

async function getSkillConfig() {
  const config = await configManager.getConfig();
  return normalizeSkillRuntimeConfig(config);
}

function evaluateGate(settings: ReturnType<typeof normalizeSkillRuntimeConfig>) {
  return skillRunner.evaluateExecuteGate({
    enabled: settings.evalGateEnabled,
    minPassRate: settings.evalMinPassRate,
    minSampleSize: settings.evalMinSampleSize
  });
}

export async function handleListSkills(args: unknown): Promise<ServerResult> {
  const parsed = ListSkillsArgsSchema.safeParse(args || {});
  if (!parsed.success) {
    return errorResponse(`Invalid arguments for list_skills: ${parsed.error}`, 'invalid_arguments');
  }

  const settings = await getSkillConfig();
  if (settings.configError) {
    return errorResponse(settings.configError.message, settings.configError.reasonCode);
  }

  if (!settings.enabled) {
    return errorResponse('Skills are disabled. Set skillsEnabled=true via set_config_value.', 'skills_disabled');
  }

  const { skills, errors } = await skillRegistry.scanSkills(settings.skillDirs);
  const query = parsed.data.query?.toLowerCase().trim();
  const filtered = skills.filter((skill) => {
    const queryMatch = !query ||
      skill.id.toLowerCase().includes(query) ||
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query);
    const tagsMatch = !parsed.data.tags?.length || parsed.data.tags.every((tag) => skill.tags.includes(tag));
    return queryMatch && tagsMatch;
  }).slice(0, parsed.data.limit);

  return jsonResponse({
    enabled: true,
    total: filtered.length,
    skills: filtered,
    errors
  });
}

export async function handleGetSkill(args: unknown): Promise<ServerResult> {
  const parsed = GetSkillArgsSchema.safeParse(args || {});
  if (!parsed.success) {
    return errorResponse(`Invalid arguments for get_skill: ${parsed.error}`, 'invalid_arguments');
  }

  const settings = await getSkillConfig();
  if (settings.configError) {
    return errorResponse(settings.configError.message, settings.configError.reasonCode);
  }

  if (!settings.enabled) {
    return errorResponse('Skills are disabled. Set skillsEnabled=true via set_config_value.', 'skills_disabled');
  }

  const skill = await skillRegistry.findSkillById(settings.skillDirs, parsed.data.skillId);
  if (!skill) {
    return errorResponse(`Skill not found: ${parsed.data.skillId}`, 'skill_not_found');
  }

  return jsonResponse({
    ...skill,
    resources: parsed.data.includeResources ? skill.resources : undefined
  });
}

export async function handleRunSkill(args: unknown): Promise<ServerResult> {
  const parsed = RunSkillArgsSchema.safeParse(args || {});
  if (!parsed.success) {
    return errorResponse(`Invalid arguments for run_skill: ${parsed.error}`, 'invalid_arguments');
  }

  const settings = await getSkillConfig();
  if (settings.configError) {
    return errorResponse(settings.configError.message, settings.configError.reasonCode);
  }

  if (!settings.enabled) {
    return errorResponse('Skills are disabled. Set skillsEnabled=true via set_config_value.', 'skills_disabled');
  }

  if (parsed.data.mode === 'execute' && settings.commandValidationMode !== 'strict') {
    return errorResponse('run_skill execute mode requires commandValidationMode="strict".', 'strict_validation_required');
  }

  if (parsed.data.mode === 'execute') {
    const gateDecision = evaluateGate(settings);
    if (!gateDecision.allowed) {
      return errorResponse(gateDecision.message || 'Execute mode blocked by eval gate.', 'eval_gate_blocked', {
        gate: gateDecision
      });
    }
  }

  if (parsed.data.mode === 'execute' && skillRunner.getPendingOrActiveCount() >= settings.maxConcurrentRuns) {
    return errorResponse(`Max concurrent skill runs reached (${settings.maxConcurrentRuns}).`, 'concurrency_limit_reached');
  }

  const skill = await skillRegistry.findSkillById(settings.skillDirs, parsed.data.skillId);
  if (!skill) {
    return errorResponse(`Skill not found: ${parsed.data.skillId}`, 'skill_not_found');
  }

  capture('skill_run_started', { skill_id: skill.id, mode: parsed.data.mode });

  const run = await skillRunner.runSkill(skill, {
    mode: parsed.data.mode,
    goal: parsed.data.goal,
    cwd: parsed.data.cwd,
    maxSteps: parsed.data.maxSteps,
    executionMode: settings.executionMode
  });

  return jsonResponse(run);
}

export async function handleApproveSkillRun(args: unknown): Promise<ServerResult> {
  const parsed = ApproveSkillRunArgsSchema.safeParse(args || {});
  if (!parsed.success) {
    return errorResponse(`Invalid arguments for approve_skill_run: ${parsed.error}`, 'invalid_arguments');
  }

  const settings = await getSkillConfig();
  if (settings.configError) {
    return errorResponse(settings.configError.message, settings.configError.reasonCode);
  }

  if (!settings.enabled) {
    return errorResponse('Skills are disabled. Set skillsEnabled=true via set_config_value.', 'skills_disabled');
  }

  if (settings.commandValidationMode !== 'strict') {
    return errorResponse('approve_skill_run requires commandValidationMode="strict".', 'strict_validation_required');
  }

  const gateDecision = evaluateGate(settings);
  if (!gateDecision.allowed) {
    return errorResponse(gateDecision.message || 'Execute mode blocked by eval gate.', 'eval_gate_blocked', {
      gate: gateDecision
    });
  }

  const run = await skillRunner.approveRun(parsed.data.runId);
  if (!run) {
    return errorResponse(`Skill run not found: ${parsed.data.runId}`, 'run_not_found');
  }

  if (run.state === 'waiting_approval') {
    return errorResponse(`Run ${parsed.data.runId} is still waiting approval.`, 'approval_required');
  }

  return jsonResponse(run);
}

export async function handleGetSkillRun(args: unknown): Promise<ServerResult> {
  const parsed = GetSkillRunArgsSchema.safeParse(args || {});
  if (!parsed.success) {
    return errorResponse(`Invalid arguments for get_skill_run: ${parsed.error}`, 'invalid_arguments');
  }

  const run = skillRunner.getRun(parsed.data.runId);
  if (!run) {
    return errorResponse(`Skill run not found: ${parsed.data.runId}`, 'run_not_found');
  }

  return jsonResponse(run);
}

export async function handleCancelSkillRun(args: unknown): Promise<ServerResult> {
  const parsed = CancelSkillRunArgsSchema.safeParse(args || {});
  if (!parsed.success) {
    return errorResponse(`Invalid arguments for cancel_skill_run: ${parsed.error}`, 'invalid_arguments');
  }

  const run = skillRunner.cancelRun(parsed.data.runId);
  if (!run) {
    return errorResponse(`Skill run not found: ${parsed.data.runId}`, 'run_not_found');
  }

  return jsonResponse(run);
}
