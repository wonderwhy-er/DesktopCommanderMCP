import path from 'path';
import { ChildProcess, spawn } from 'child_process';
import type {
  SkillDescriptor,
  SkillExecutionSummary,
  SkillPlanStep,
  SkillRun,
  SkillRunMode,
  SkillRunState,
  SkillStepOutcome,
  SkillStepVerification,
  SkillReasonCode,
  SkillExecuteEvalStats
} from './types.js';
import { capture } from '../utils/capture.js';
import { handleReadFile } from '../handlers/filesystem-handlers.js';
import { handleStartSearch } from '../handlers/search-handlers.js';

interface RunSkillOptions {
  mode: SkillRunMode;
  goal: string;
  cwd?: string;
  maxSteps: number;
  executionMode: 'plan_only' | 'confirm' | 'auto_safe';
}

interface RunContext {
  skill: SkillDescriptor;
  options: RunSkillOptions;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecuteGateOptions {
  enabled: boolean;
  minPassRate: number;
  minSampleSize: number;
}

interface ExecuteGateDecision {
  allowed: boolean;
  reasonCode?: SkillReasonCode;
  message?: string;
  stats: SkillExecuteEvalStats;
}

const SAFE_COMMANDS = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'rg',
  'find',
  'echo'
]);

const DISALLOWED_SHELL_PATTERN = /[;&|`$()<>]/;

function nowIso(): string {
  return new Date().toISOString();
}

function nextState(run: SkillRun, state: SkillRunState): void {
  run.state = state;
  run.updatedAt = nowIso();
}

function deriveSafeCommandFromGoal(goal: string): string {
  const normalized = goal.toLowerCase();
  if (normalized.includes('list') || normalized.includes('files')) {
    return 'ls';
  }
  if (normalized.includes('count') || normalized.includes('lines')) {
    return 'wc -l SKILL.md';
  }
  if (normalized.includes('search') || normalized.includes('find')) {
    return 'rg --version';
  }
  return 'pwd';
}

export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  const rel = path.relative(normalizedRoot, normalizedCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isSafeCommand(command: string): { safe: boolean; reasonCode?: SkillReasonCode } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { safe: false, reasonCode: 'empty_command' };
  }

  if (DISALLOWED_SHELL_PATTERN.test(trimmed)) {
    return { safe: false, reasonCode: 'disallowed_operator' };
  }

  const [binary] = trimmed.split(/\s+/);
  const base = path.basename(binary).toLowerCase();
  if (!SAFE_COMMANDS.has(base)) {
    return { safe: false, reasonCode: 'command_not_allowlisted' };
  }

  return { safe: true };
}

export function buildDeterministicPlan(skill: SkillDescriptor, goal: string, maxSteps: number): SkillPlanStep[] {
  const steps: SkillPlanStep[] = [
    {
      id: 'step-1',
      type: 'read',
      title: 'Inspect skill instructions',
      details: `Read SKILL.md for "${skill.id}" and extract required sequence for goal: ${goal}`,
      verify: 'Skill instructions loaded successfully'
    },
    {
      id: 'step-2',
      type: 'search',
      title: 'Discover relevant files',
      details: 'Run code/file search in the target working tree to locate required inputs and outputs',
      verify: 'At least one relevant file or directory located'
    }
  ];

  if (skill.resources.scripts.length > 0 && steps.length < maxSteps) {
    steps.push({
      id: `step-${steps.length + 1}`,
      type: 'script',
      title: 'Execute deterministic script',
      details: `Run one skill script (${skill.resources.scripts[0]}) with explicit parameters`,
      verify: 'Script exits with code 0'
    });
  }

  if (steps.length < maxSteps) {
    steps.push({
      id: `step-${steps.length + 1}`,
      type: 'command_safe',
      title: 'Run safe command checks',
      details: `Use allowlisted commands only: ${Array.from(SAFE_COMMANDS).join(', ')}`,
      verify: 'All command invocations are allowlisted',
      payload: {
        command: deriveSafeCommandFromGoal(goal)
      }
    });
  }

  return steps.slice(0, maxSteps);
}

function createEmptySummary(): SkillExecutionSummary {
  return {
    stepOutcomes: [],
    passed: false,
    rollbackHints: []
  };
}

function createVerification(passed: boolean, checks: string[], evidence: string[], failureReason?: string): SkillStepVerification {
  return {
    passed,
    checks,
    evidence,
    failureReason
  };
}

export class SkillRunner {
  private runs = new Map<string, SkillRun>();
  private contexts = new Map<string, RunContext>();
  private activeProcesses = new Map<string, ChildProcess>();
  private evalStats: SkillExecuteEvalStats = {
    totalRuns: 0,
    passedRuns: 0,
    failedRuns: 0,
    passRate: 0,
    lastUpdatedAt: undefined
  };

  getPendingOrActiveCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.state === 'planning' || run.state === 'waiting_approval' || run.state === 'executing' || run.state === 'verifying') {
        count++;
      }
    }
    return count;
  }

  getExecuteEvalStats(): SkillExecuteEvalStats {
    return { ...this.evalStats };
  }

  resetExecuteEvalStats(): void {
    this.evalStats = {
      totalRuns: 0,
      passedRuns: 0,
      failedRuns: 0,
      passRate: 0,
      lastUpdatedAt: undefined
    };
  }

  evaluateExecuteGate(options: ExecuteGateOptions): ExecuteGateDecision {
    const stats = this.getExecuteEvalStats();
    if (!options.enabled) {
      return {
        allowed: true,
        stats
      };
    }

    if (stats.totalRuns < options.minSampleSize) {
      return {
        allowed: false,
        reasonCode: 'eval_gate_blocked',
        message: `Execute mode blocked by eval gate: sample size ${stats.totalRuns}/${options.minSampleSize}.`,
        stats
      };
    }

    if (stats.passRate < options.minPassRate) {
      return {
        allowed: false,
        reasonCode: 'eval_gate_blocked',
        message: `Execute mode blocked by eval gate: pass rate ${(stats.passRate * 100).toFixed(1)}% is below required ${(options.minPassRate * 100).toFixed(1)}%.`,
        stats
      };
    }

    return {
      allowed: true,
      stats
    };
  }

  private recordExecuteOutcome(passed: boolean): void {
    this.evalStats.totalRuns += 1;
    if (passed) {
      this.evalStats.passedRuns += 1;
    } else {
      this.evalStats.failedRuns += 1;
    }
    this.evalStats.passRate = this.evalStats.totalRuns === 0 ? 0 : this.evalStats.passedRuns / this.evalStats.totalRuns;
    this.evalStats.lastUpdatedAt = nowIso();
  }

  private stopActiveProcess(runId: string): void {
    const child = this.activeProcesses.get(runId);
    if (!child || child.killed) {
      return;
    }

    child.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      const stillActive = this.activeProcesses.get(runId);
      if (stillActive && !stillActive.killed) {
        stillActive.kill('SIGKILL');
      }
    }, 1000);
    forceKillTimer.unref();
  }

  private async runChildProcess(runId: string, command: string, args: string[], cwd: string, timeoutMs = 15000): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        env: process.env
      });
      this.activeProcesses.set(runId, child);

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (this.activeProcesses.get(runId) === child) {
          this.activeProcesses.delete(runId);
        }
        if (timedOut) {
          resolve({ exitCode: 124, stdout, stderr: `${stderr}\nProcess timed out` });
          return;
        }
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        if (this.activeProcesses.get(runId) === child) {
          this.activeProcesses.delete(runId);
        }
        resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
      });
    });
  }

  private async resolveAndValidateCwd(options: RunSkillOptions, skill: SkillDescriptor): Promise<{ cwd?: string; reasonCode?: SkillReasonCode; reason?: string }> {
    const requestedCwd = options.cwd ? path.resolve(options.cwd) : skill.path;

    try {
      const { validatePath } = await import('../tools/filesystem.js');
      const validCwd = await validatePath(requestedCwd);
      return { cwd: validCwd };
    } catch (error) {
      return {
        reasonCode: 'cwd_outside_allowed_roots',
        reason: `CWD not allowed: ${requestedCwd}. ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async runSkill(skill: SkillDescriptor, options: RunSkillOptions): Promise<SkillRun> {
    const runId = `skill_run_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const run: SkillRun = {
      runId,
      skillId: skill.id,
      goal: options.goal,
      mode: options.mode,
      cwd: options.cwd,
      state: 'queued',
      steps: [],
      currentStep: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      artifacts: [],
      failures: [],
      requiresApproval: false,
      nextAction: 'none',
      executionSummary: createEmptySummary()
    };
    this.runs.set(runId, run);
    this.contexts.set(runId, { skill, options });

    nextState(run, 'planning');
    run.steps = buildDeterministicPlan(skill, options.goal, options.maxSteps);

    if (options.mode === 'plan') {
      run.executionSummary.passed = true;
      nextState(run, 'completed');
      capture('skill_run_completed', { run_id: runId, skill_id: skill.id, mode: 'plan' });
      return run;
    }

    if (options.executionMode === 'plan_only') {
      run.failures.push('Server is configured for plan_only execution mode.');
      run.executionSummary.rollbackHints.push('Set skillExecutionMode to "confirm" or "auto_safe" to execute.');
      nextState(run, 'failed');
      capture('skill_step_failed', { run_id: runId, skill_id: skill.id, reason: 'plan_only_mode' });
      return run;
    }

    if (options.executionMode === 'confirm') {
      run.requiresApproval = true;
      run.nextAction = 'approve_skill_run';
      nextState(run, 'waiting_approval');
      capture('safety_blocked', { run_id: runId, skill_id: skill.id, reason: 'approval_required' });
      return run;
    }

    await this.executePlanSteps(runId);
    return run;
  }

  async approveRun(runId: string): Promise<SkillRun | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.state !== 'waiting_approval') {
      run.failures.push(`Invalid transition: cannot approve from state "${run.state}".`);
      run.executionSummary.rollbackHints.push('Only runs in waiting_approval can be approved.');
      return run;
    }
    run.requiresApproval = false;
    run.nextAction = 'none';
    await this.executePlanSteps(runId);
    return run;
  }

  private async executePlanSteps(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    const context = this.contexts.get(runId);
    if (!run || !context) {
      return;
    }
    const { skill, options } = context;

    nextState(run, 'executing');
    for (let i = 0; i < run.steps.length; i++) {
      if (run.state === 'canceled') {
        run.executionSummary.rollbackHints.push('Run was canceled before completion.');
        return;
      }

      run.currentStep = i;
      const step = run.steps[i];
      capture('skill_step_started', { run_id: run.runId, skill_id: run.skillId, step_id: step.id, step_type: step.type });
      const outcome = await this.executeSingleStep(step, skill, options, run);
      run.executionSummary.stepOutcomes.push(outcome);

      if (this.runs.get(run.runId)?.state === 'canceled') {
        run.executionSummary.rollbackHints.push('Run canceled by user during execution.');
        return;
      }

      if (outcome.status === 'failed' || outcome.status === 'blocked') {
        run.failures.push(`${step.id}: ${outcome.verification.failureReason || outcome.reasonCode || 'step_failed'}`);
        run.executionSummary.rollbackHints.push(`Review ${step.id} and retry after addressing ${outcome.reasonCode || 'verification failure'}.`);
        nextState(run, 'failed');
        this.recordExecuteOutcome(false);
        capture('skill_step_failed', {
          run_id: run.runId,
          skill_id: run.skillId,
          step_id: step.id,
          reason: outcome.reasonCode || 'verification_failed'
        });
        return;
      }
    }

    nextState(run, 'verifying');
    const allPassed = run.executionSummary.stepOutcomes.every((outcome) => outcome.verification.passed);
    run.executionSummary.passed = allPassed;
    if (!allPassed) {
      run.executionSummary.rollbackHints.push('Verification did not pass for all steps.');
      nextState(run, 'failed');
      this.recordExecuteOutcome(false);
      capture('skill_step_failed', { run_id: run.runId, skill_id: run.skillId, reason: 'final_verification_failed' });
      return;
    }

    nextState(run, 'completed');
    this.recordExecuteOutcome(true);
    capture('skill_run_completed', { run_id: run.runId, skill_id: run.skillId, mode: 'execute' });
  }

  private async executeSingleStep(
    step: SkillPlanStep,
    skill: SkillDescriptor,
    options: RunSkillOptions,
    run: SkillRun
  ): Promise<SkillStepOutcome> {
    const startedAt = nowIso();

    const buildOutcome = (
      status: SkillStepOutcome['status'],
      verification: SkillStepVerification,
      reasonCode?: SkillReasonCode,
      outputSummary?: string
    ): SkillStepOutcome => ({
      stepId: step.id,
      type: step.type,
      status,
      startedAt,
      finishedAt: nowIso(),
      reasonCode,
      outputSummary,
      verification
    });

    const cwdResult = await this.resolveAndValidateCwd(options, skill);
    if (!cwdResult.cwd) {
      return buildOutcome(
        'blocked',
        createVerification(false, ['cwd_within_allowed_roots'], [cwdResult.reason || 'cwd check failed'], cwdResult.reason || 'Invalid cwd'),
        cwdResult.reasonCode || 'cwd_outside_allowed_roots'
      );
    }
    const cwd = cwdResult.cwd;

    if (step.type === 'read') {
      const skillMdPath = path.join(skill.path, 'SKILL.md');
      const result = await handleReadFile({ path: skillMdPath, offset: 0, length: 120 });
      if (result.isError) {
        return buildOutcome(
          'failed',
          createVerification(false, ['read_result_not_error'], ['read_file returned isError=true'], 'Unable to read SKILL.md'),
          'read_failed'
        );
      }
      const text = result.content?.[0]?.text || '';
      const verification = createVerification(
        text.length > 0,
        ['skill_markdown_nonempty'],
        [text.substring(0, 160)],
        text.length > 0 ? undefined : 'SKILL.md content was empty'
      );
      return buildOutcome(verification.passed ? 'completed' : 'failed', verification, verification.passed ? undefined : 'read_empty');
    }

    if (step.type === 'search') {
      const result = await handleStartSearch({
        path: cwd,
        pattern: options.goal,
        searchType: 'content',
        ignoreCase: true,
        maxResults: 20,
        timeout_ms: 1500,
        earlyTermination: false
      });
      if (result.isError) {
        return buildOutcome(
          'failed',
          createVerification(false, ['search_result_not_error'], ['start_search returned isError=true'], 'Search failed'),
          'search_failed'
        );
      }
      const text = result.content?.[0]?.text || '';
      const verification = createVerification(
        text.includes('Started') || text.includes('No'),
        ['search_session_started_or_no_results'],
        [text.substring(0, 200)],
        'Search response did not include expected markers'
      );
      return buildOutcome(verification.passed ? 'completed' : 'failed', verification, verification.passed ? undefined : 'search_unexpected_response');
    }

    if (step.type === 'script') {
      let skillRoot = path.resolve(skill.path);
      try {
        const { validatePath } = await import('../tools/filesystem.js');
        skillRoot = await validatePath(skill.path);
      } catch {
        // Fall back to resolved path if validation fails.
      }

      if (!isPathWithinRoot(cwd, skillRoot)) {
        return buildOutcome(
          'blocked',
          createVerification(
            false,
            ['script_cwd_within_skill_root'],
            [cwd, skillRoot],
            'Script execution cwd must stay within the skill directory'
          ),
          'script_cwd_outside_skill'
        );
      }

      const scriptName = skill.resources.scripts[0];
      if (!scriptName) {
        return buildOutcome(
          'blocked',
          createVerification(false, ['script_exists'], ['No scripts found in skill resources'], 'No scripts available to execute'),
          'missing_script'
        );
      }

      const scriptRoot = path.join(skill.path, 'scripts');
      const scriptPath = path.resolve(scriptRoot, scriptName);
      if (!path.isAbsolute(scriptPath) || !isPathWithinRoot(scriptPath, scriptRoot)) {
        return buildOutcome(
          'blocked',
          createVerification(false, ['script_path_scoped'], [scriptPath], 'Script path escaped skill scripts directory'),
          'script_outside_scope'
        );
      }

      let command = '';
      let args: string[] = [];
      const ext = path.extname(scriptPath).toLowerCase();
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        command = process.execPath;
        args = [scriptPath];
      } else if (ext === '.py') {
        command = 'python3';
        args = [scriptPath];
      } else if (ext === '.sh') {
        command = '/bin/bash';
        args = [scriptPath];
      } else {
        return buildOutcome(
          'blocked',
          createVerification(false, ['script_extension_allowlisted'], [ext], `Unsupported script extension: ${ext}`),
          'unsupported_script_extension'
        );
      }

      const proc = await this.runChildProcess(run.runId, command, args, cwd, 15000);
      if (run.state === 'canceled') {
        return buildOutcome(
          'skipped',
          createVerification(true, ['run_canceled'], ['Run canceled during script execution'])
        );
      }

      const evidence = [proc.stdout.substring(0, 200), proc.stderr.substring(0, 200)].filter(Boolean);
      const verification = createVerification(
        proc.exitCode === 0,
        ['script_exit_code_zero'],
        evidence,
        proc.exitCode === 0 ? undefined : `Script exited with code ${proc.exitCode}`
      );
      if (verification.passed) {
        run.artifacts.push(`Executed script ${scriptName} successfully.`);
      }
      return buildOutcome(
        verification.passed ? 'completed' : 'failed',
        verification,
        verification.passed ? undefined : 'script_nonzero_exit',
        proc.stdout.substring(0, 200) || proc.stderr.substring(0, 200)
      );
    }

    const command = step.payload?.command || deriveSafeCommandFromGoal(options.goal);
    const safety = isSafeCommand(command);
    if (!safety.safe) {
      return buildOutcome(
        'blocked',
        createVerification(false, ['command_allowlisted'], [command], `Command rejected by allowlist (${safety.reasonCode})`),
        safety.reasonCode || 'command_rejected'
      );
    }

    const [binary, ...cmdArgs] = command.split(/\s+/);
    const proc = await this.runChildProcess(run.runId, binary, cmdArgs, cwd, 5000);
    if (run.state === 'canceled') {
      return buildOutcome(
        'skipped',
        createVerification(true, ['run_canceled'], ['Run canceled during command execution'])
      );
    }

    const verification = createVerification(
      proc.exitCode === 0,
      ['command_exit_code_zero'],
      [proc.stdout.substring(0, 120), proc.stderr.substring(0, 120)].filter(Boolean),
      proc.exitCode === 0 ? undefined : `Safe command exited with code ${proc.exitCode}`
    );
    if (verification.passed) {
      run.artifacts.push(`Safe command executed: ${command}`);
    }
    return buildOutcome(
      verification.passed ? 'completed' : 'failed',
      verification,
      verification.passed ? undefined : 'command_nonzero_exit',
      proc.stdout.substring(0, 200) || proc.stderr.substring(0, 200)
    );
  }

  getRun(runId: string): SkillRun | null {
    return this.runs.get(runId) || null;
  }

  cancelRun(runId: string): SkillRun | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'canceled') {
      return run;
    }

    nextState(run, 'canceled');
    run.requiresApproval = false;
    run.nextAction = 'none';
    run.executionSummary.rollbackHints.push('Run canceled by user.');
    this.stopActiveProcess(runId);
    capture('skill_step_failed', { run_id: runId, skill_id: run.skillId, reason: 'canceled' });
    return run;
  }
}

export const skillRunner = new SkillRunner();
