import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { getShellSpawnArgs } from './utils/shell.js';

export interface FiniteInvocation {
  executable: string;
  argv: readonly string[];
  cwd: string;
  input?: string;
}
// These are received owner documents, not a Desktop Commander lifecycle model.
export type OwnerDocument = Record<string, any>;
export interface FleetFiniteCommand {
  process: ChildProcess;
  operationId: string;
  completion: Promise<OwnerDocument>;
  cancel(): Promise<OwnerDocument>;
  admission?: OwnerDocument;
  receipt?: OwnerDocument;
}

/** A transport to the existing retained owner. It selects no executor, limits, signals or terminal. */
export function startFleetFiniteCommand(invocation: FiniteInvocation, shell: string,
  observeAdmission: (admission: OwnerDocument) => void = () => {}): FleetFiniteCommand {
  const launch = getShellSpawnArgs(shell, 'ai-fleet harness tool-execution finite-command serve');
  const child = spawn(launch.executable, launch.args, {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    ...(launch.useShellOption ? { shell: launch.useShellOption } : {}),
  });
  const operationId = 'fleet-finite-' + randomUUID();
  let resolve!: (receipt: OwnerDocument) => void, reject!: (error: Error) => void;
  let resolveCancel!: (control: OwnerDocument) => void, rejectCancel!: (error: Error) => void;
  const completion = new Promise<OwnerDocument>((yes, no) => { resolve = yes; reject = no; });
  completion.catch(() => undefined);
  let cancellation: Promise<OwnerDocument> | undefined;
  let readySchema: string | undefined;
  let cancelled = false, settled = false;
  let diagnostic = '';
  const send = (id: number, operation: string, extra: OwnerDocument = {}) =>
    child.stdin.write(JSON.stringify({ id, operationId, operation, ...extra }) + '\n');
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    child.stdin.end();
    const retained = new Error(error.message + '; retained operation ' + operationId +
      '; recover with ai-fleet harness tool-execution finite-command show ' + operationId);
    reject(retained); rejectCancel?.(retained);
  };
  const command: FleetFiniteCommand = {
    process: child, operationId, completion,
    cancel() {
      if (command.receipt) return Promise.resolve(command.receipt);
      if (!cancellation) {
        cancellation = new Promise<OwnerDocument>((yes, no) => { resolveCancel = yes; rejectCancel = no; });
        cancellation.catch(() => undefined);
        cancelled = true;
        if (readySchema) send(2, 'cancel');
      }
      return cancellation;
    },
  };
  child.stdin.on('error', fail);
  child.once('error', fail);
  child.stderr.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-4096); });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.ready === true && typeof message.schema === 'string' && !readySchema) {
        readySchema = message.schema;
        send(1, 'execute', { input: { ...invocation, requireCancellation: true } });
        if (cancelled) send(2, 'cancel');
        return;
      }
      if (!readySchema || message.schema !== readySchema) throw new Error('Unexpected finite owner protocol');
      if (message.error) throw new Error(String(message.error));
      if (message.id === 2 && message.control) { resolveCancel?.(message.control); return; }
      if (message.id !== 1) throw new Error('Unexpected finite owner response identity');
      if (message.admission) {
        if (message.admission.operationId !== operationId) throw new Error('Finite admission addresses another operation');
        command.admission = message.admission;
        observeAdmission(message.admission);
      } else if (message.receipt) {
        if (message.receipt.admission?.operationId !== operationId) throw new Error('Finite receipt addresses another operation');
        command.receipt = message.receipt;
        settled = true;
        child.stdin.end();
        resolve(message.receipt);
        resolveCancel?.(message.receipt);
      } else throw new Error('Unexpected finite owner message');
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  child.once('close', (code, signal) => {
    if (!settled) fail(new Error('Finite owner transport closed without a receipt (' + (code ?? signal) + '): ' + diagnostic));
  });
  return command;
}

/** Present selected fields from the original receipt, retaining the owner's vocabulary. */
export function formatFiniteOwner(document: OwnerDocument | undefined): string {
  if (!document) return '';
  const admission = document.admission ?? document;
  const result = document.evidence?.result;
  return '\nFinite owner: ' + JSON.stringify({ operationId: admission.operationId,
    policy: admission.policy, limits: admission.limits, resultId: document.resultId,
    executor: document.evidence?.executor, package: document.evidence?.package,
    terminal: result?.terminal, cleanup: result?.cleanup, cleanupComplete: result?.cleanupComplete,
    exitCode: result?.exitCode, diagnostic: result?.diagnostic,
    notStarted: document.notStarted, refusal: document.refusal });
}
export function finiteOwnerFailed(receipt: OwnerDocument | undefined): boolean {
  if (!receipt) return false;
  const result = receipt.evidence?.result;
  return !result || result.terminal !== 'completed' || result.exitCode !== 0 || result.cleanupComplete !== true;
}
