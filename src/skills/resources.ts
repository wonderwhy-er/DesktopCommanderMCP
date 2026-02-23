import { createHash } from 'crypto';
import type { SkillRun } from './types.js';
import { configManager } from '../config-manager.js';
import { normalizeSkillRuntimeConfig } from './runtime-config.js';
import { skillRegistry } from './registry.js';
import { skillRunner } from './runner.js';

const JSON_MIME = 'application/json';

export const SKILLS_CATALOG_URI = 'dc://skills/catalog';
export const SKILLS_EVAL_GATE_URI = 'dc://skills/eval-gate';
export const SKILL_RUN_URI_TEMPLATE = 'dc://skills/runs/{runId}';

const SKILL_RUN_PATH_PREFIX = '/runs/';

function stableStringify(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function truncate(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 3))}...`;
}

function safePreview(input: unknown, maxLen: number): string {
  if (input === undefined || input === null) return '';
  return truncate(String(input), maxLen);
}

function parseRunIdFromUri(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'dc:' || url.host !== 'skills') return null;
    if (!url.pathname.startsWith(SKILL_RUN_PATH_PREFIX)) return null;
    const raw = url.pathname.slice(SKILL_RUN_PATH_PREFIX.length);
    return raw ? decodeURIComponent(raw) : null;
  } catch {
    return null;
  }
}

function toSafeRunView(run: SkillRun) {
  const goalPreview = safePreview(run.goal, 200);
  const failures = (run.failures || []).map((f) => truncate(String(f), 200));

  return {
    runId: run.runId,
    skillId: run.skillId,
    mode: run.mode,
    state: run.state,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    requiresApproval: run.requiresApproval,
    nextAction: run.nextAction,
    currentStep: run.currentStep,
    // Avoid returning raw goal/cwd/details/evidence in resources.
    goalPreview,
    goalSha256: sha256Hex(String(run.goal || '')),
    steps: (run.steps || []).map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      verify: s.verify,
    })),
    failures,
    executionSummary: {
      passed: !!run.executionSummary?.passed,
      rollbackHints: (run.executionSummary?.rollbackHints || []).map((h) => truncate(String(h), 200)),
      stepOutcomes: (run.executionSummary?.stepOutcomes || []).map((o) => ({
        stepId: o.stepId,
        type: o.type,
        status: o.status,
        startedAt: o.startedAt,
        finishedAt: o.finishedAt,
        reasonCode: o.reasonCode,
        verification: {
          passed: !!o.verification?.passed,
          checks: o.verification?.checks || [],
          failureReason: o.verification?.failureReason ? truncate(String(o.verification.failureReason), 200) : undefined,
        },
      })),
    },
  };
}

export function listSkillResources() {
  return [
    {
      name: 'skills_catalog',
      uri: SKILLS_CATALOG_URI,
      title: 'Skills Catalog',
      description: 'Read-only catalog of discovered skills and parse errors.',
      mimeType: JSON_MIME,
    },
    {
      name: 'skills_eval_gate',
      uri: SKILLS_EVAL_GATE_URI,
      title: 'Skills Execute Eval Gate',
      description: 'Read-only snapshot of eval-gate thresholds, stats, and allow/deny decision.',
      mimeType: JSON_MIME,
    },
  ];
}

export function listSkillResourceTemplates() {
  return [
    {
      name: 'skill_run',
      uriTemplate: SKILL_RUN_URI_TEMPLATE,
      title: 'Skill Run View',
      description: 'Read-only view of a skill run by runId.',
      mimeType: JSON_MIME,
    },
  ];
}

export async function readSkillResource(uri: string) {
  const config = await configManager.getConfig();
  const settings = normalizeSkillRuntimeConfig(config);

  const baseMeta = {
    schemaVersion: 1,
    enabled: settings.enabled,
  };

  if (uri === SKILLS_CATALOG_URI) {
    if (settings.configError) {
      return {
        contents: [
          {
            uri,
            mimeType: JSON_MIME,
            text: stableStringify({
              ...baseMeta,
              enabled: false,
              configError: settings.configError,
              skills: [],
              errors: [],
            }),
          },
        ],
      };
    }

    if (!settings.enabled) {
      return {
        contents: [
          {
            uri,
            mimeType: JSON_MIME,
            text: stableStringify({
              ...baseMeta,
              enabled: false,
              message: 'Skills are disabled. Set skillsEnabled=true to discover skills via tools.',
              skills: [],
              errors: [],
            }),
          },
        ],
      };
    }

    const { skills, errors } = await skillRegistry.scanSkills(settings.skillDirs);
    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: stableStringify({
            ...baseMeta,
            total: skills.length,
            skills,
            errors,
          }),
        },
      ],
    };
  }

  if (uri === SKILLS_EVAL_GATE_URI) {
    if (settings.configError) {
      return {
        contents: [
          {
            uri,
            mimeType: JSON_MIME,
            text: stableStringify({
              ...baseMeta,
              enabled: false,
              configError: settings.configError,
              thresholds: null,
              stats: skillRunner.getExecuteEvalStats(),
              decision: { allowed: false, reasonCode: settings.configError.reasonCode },
            }),
          },
        ],
      };
    }

    const decision = skillRunner.evaluateExecuteGate({
      enabled: settings.evalGateEnabled,
      minPassRate: settings.evalMinPassRate,
      minSampleSize: settings.evalMinSampleSize,
    });

    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: stableStringify({
            ...baseMeta,
            thresholds: {
              evalGateEnabled: settings.evalGateEnabled,
              minPassRate: settings.evalMinPassRate,
              minSampleSize: settings.evalMinSampleSize,
            },
            stats: decision.stats,
            decision: {
              allowed: decision.allowed,
              reasonCode: decision.reasonCode,
              message: decision.message,
            },
          }),
        },
      ],
    };
  }

  const runId = parseRunIdFromUri(uri);
  if (runId) {
    const run = skillRunner.getRun(runId);
    if (!run) {
      return {
        contents: [
          {
            uri,
            mimeType: JSON_MIME,
            text: stableStringify({
              ...baseMeta,
              found: false,
              reasonCode: 'run_not_found',
              message: `Skill run not found: ${runId}`,
            }),
          },
        ],
      };
    }

    return {
      contents: [
        {
          uri,
          mimeType: JSON_MIME,
          text: stableStringify({
            ...baseMeta,
            found: true,
            run: toSafeRunView(run),
          }),
        },
      ],
    };
  }

  return null;
}

