import type { ServerConfig } from '../config-manager.js';
import type { SkillReasonCode } from './types.js';

export interface SkillConfigError {
  reasonCode: SkillReasonCode;
  message: string;
}

export interface NormalizedSkillRuntimeConfig {
  enabled: boolean;
  skillDirs: string[];
  executionMode: 'plan_only' | 'confirm' | 'auto_safe';
  commandValidationMode: 'strict' | 'legacy';
  maxConcurrentRuns: number;
  evalGateEnabled: boolean;
  evalMinPassRate: number;
  evalMinSampleSize: number;
  configError?: SkillConfigError;
}

function normalizePositiveInt(
  value: unknown,
  defaultValue: number,
  reasonCode: SkillReasonCode,
  label: string
): { value: number; error?: SkillConfigError } {
  if (value === undefined || value === null) {
    return { value: defaultValue };
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      value: defaultValue,
      error: {
        reasonCode,
        message: `Invalid ${label}. Expected integer >= 1.`
      }
    };
  }

  return { value: Math.floor(parsed) };
}

function normalizePassRate(value: unknown): { value: number; error?: SkillConfigError } {
  if (value === undefined || value === null) {
    return { value: 0.95 };
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return {
      value: 0.95,
      error: {
        reasonCode: 'invalid_eval_gate_pass_rate',
        message: 'Invalid skillExecuteMinPassRate. Expected number between 0 and 1.'
      }
    };
  }

  return { value: parsed };
}

function normalizeBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().trim();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return defaultValue;
}

export function normalizeSkillRuntimeConfig(config: ServerConfig): NormalizedSkillRuntimeConfig {
  const enabled = config.skillsEnabled === true;

  const maxRuns = normalizePositiveInt(
    config.skillMaxConcurrentRuns,
    1,
    'invalid_skill_max_concurrent_runs',
    'skillMaxConcurrentRuns'
  );
  if (maxRuns.error) {
    return {
      enabled,
      skillDirs: config.skillsDirectories || [],
      executionMode: config.skillExecutionMode || 'confirm',
      commandValidationMode: config.commandValidationMode || 'strict',
      maxConcurrentRuns: maxRuns.value,
      evalGateEnabled: normalizeBoolean(config.skillExecuteEvalGateEnabled, enabled),
      evalMinPassRate: 0.95,
      evalMinSampleSize: 50,
      configError: maxRuns.error
    };
  }

  const minPassRate = normalizePassRate(config.skillExecuteMinPassRate);
  if (minPassRate.error) {
    return {
      enabled,
      skillDirs: config.skillsDirectories || [],
      executionMode: config.skillExecutionMode || 'confirm',
      commandValidationMode: config.commandValidationMode || 'strict',
      maxConcurrentRuns: maxRuns.value,
      evalGateEnabled: normalizeBoolean(config.skillExecuteEvalGateEnabled, enabled),
      evalMinPassRate: minPassRate.value,
      evalMinSampleSize: 50,
      configError: minPassRate.error
    };
  }

  const minSample = normalizePositiveInt(
    config.skillExecuteMinSampleSize,
    50,
    'invalid_eval_gate_sample_size',
    'skillExecuteMinSampleSize'
  );
  if (minSample.error) {
    return {
      enabled,
      skillDirs: config.skillsDirectories || [],
      executionMode: config.skillExecutionMode || 'confirm',
      commandValidationMode: config.commandValidationMode || 'strict',
      maxConcurrentRuns: maxRuns.value,
      evalGateEnabled: normalizeBoolean(config.skillExecuteEvalGateEnabled, enabled),
      evalMinPassRate: minPassRate.value,
      evalMinSampleSize: minSample.value,
      configError: minSample.error
    };
  }

  return {
    enabled,
    skillDirs: config.skillsDirectories || [],
    executionMode: config.skillExecutionMode || 'confirm',
    commandValidationMode: config.commandValidationMode || 'strict',
    maxConcurrentRuns: maxRuns.value,
    evalGateEnabled: normalizeBoolean(config.skillExecuteEvalGateEnabled, enabled),
    evalMinPassRate: minPassRate.value,
    evalMinSampleSize: minSample.value
  };
}
