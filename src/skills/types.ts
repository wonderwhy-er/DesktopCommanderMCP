export type SkillExecutionMode = 'plan_only' | 'confirm' | 'auto_safe';
export type SkillRunMode = 'plan' | 'execute';
export type SkillReasonCode =
  | 'invalid_arguments'
  | 'skills_disabled'
  | 'strict_validation_required'
  | 'invalid_skill_max_concurrent_runs'
  | 'concurrency_limit_reached'
  | 'invalid_eval_gate_pass_rate'
  | 'invalid_eval_gate_sample_size'
  | 'eval_gate_blocked'
  | 'skill_not_found'
  | 'run_not_found'
  | 'invalid_transition'
  | 'approval_required'
  | 'plan_only_mode'
  | 'cwd_outside_allowed_roots'
  | 'script_cwd_outside_skill'
  | 'empty_command'
  | 'disallowed_operator'
  | 'command_not_allowlisted'
  | 'read_failed'
  | 'read_empty'
  | 'search_failed'
  | 'search_unexpected_response'
  | 'missing_script'
  | 'script_outside_scope'
  | 'unsupported_script_extension'
  | 'script_nonzero_exit'
  | 'command_rejected'
  | 'command_nonzero_exit'
  | 'verification_failed'
  | 'final_verification_failed'
  | 'canceled';
export type SkillRunState =
  | 'queued'
  | 'planning'
  | 'waiting_approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface SkillResourceSummary {
  scripts: string[];
  references: string[];
  assets: string[];
}

export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  path: string;
  tags: string[];
  resources: SkillResourceSummary;
}

export interface SkillRegistryError {
  path: string;
  code: string;
  message: string;
}

export interface SkillPlanStep {
  id: string;
  type: 'read' | 'search' | 'script' | 'command_safe';
  title: string;
  details: string;
  verify: string;
  payload?: {
    command?: string;
  };
}

export interface SkillStepVerification {
  passed: boolean;
  checks: string[];
  evidence: string[];
  failureReason?: string;
}

export interface SkillStepOutcome {
  stepId: string;
  type: SkillPlanStep['type'];
  status: 'completed' | 'failed' | 'blocked' | 'skipped';
  startedAt: string;
  finishedAt: string;
  reasonCode?: SkillReasonCode;
  outputSummary?: string;
  verification: SkillStepVerification;
}

export interface SkillExecutionSummary {
  stepOutcomes: SkillStepOutcome[];
  passed: boolean;
  rollbackHints: string[];
}

export interface SkillRun {
  runId: string;
  skillId: string;
  goal: string;
  mode: SkillRunMode;
  cwd?: string;
  state: SkillRunState;
  steps: SkillPlanStep[];
  currentStep: number;
  createdAt: string;
  updatedAt: string;
  artifacts: string[];
  failures: string[];
  requiresApproval: boolean;
  nextAction: 'approve_skill_run' | 'none';
  executionSummary: SkillExecutionSummary;
}

export interface SkillExecuteEvalStats {
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  passRate: number;
  lastUpdatedAt?: string;
}
