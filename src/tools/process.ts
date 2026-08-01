import { listPlatformProcesses, type DetailedProcessInfo } from '../platform/processes.js';
import { ServerResult } from '../types.js';
import { KillProcessArgsSchema, ListProcessesArgsSchema } from './schemas.js';

const PROCESS_ARG_LIMIT = 500;
const SENSITIVE_NAME = [
  'pass(?:word|wd)?',
  'pwd',
  'token',
  'api[-_]?key',
  'secret',
  'client[-_]?secret',
  'access[-_]?token',
  'refresh[-_]?token',
  'auth(?:orization)?',
  'connection[-_]?string',
  'database[-_]?url',
].join('|');

const SENSITIVE_FLAG_PATTERN = new RegExp(
  `(^|\\s)(--?(?:${SENSITIVE_NAME}))(=|\\s+)(?:"[^"]*"|'[^']*'|\\S+)`,
  'gi',
);
const SENSITIVE_ENV_PATTERN = new RegExp(
  `\\b([A-Za-z0-9_]*(?:${SENSITIVE_NAME})[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\\S+)`,
  'gi',
);

export function redactProcessArgs(args: string): string {
  const redacted = args
    .replace(SENSITIVE_FLAG_PATTERN, '$1$2$3[REDACTED]')
    .replace(SENSITIVE_ENV_PATTERN, '$1=[REDACTED]')
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s\/@]+):[^@\s]+@/gi, '$1:[REDACTED]@');

  if (redacted.length <= PROCESS_ARG_LIMIT) {
    return redacted;
  }

  return `${redacted.slice(0, PROCESS_ARG_LIMIT - 3)}...`;
}

interface ProcessListOptions {
  includeArgs: boolean;
  offset: number;
  limit: number;
}

export function formatProcessList(
  processes: DetailedProcessInfo[],
  options: ProcessListOptions,
): string {
  const page = processes.slice(options.offset, options.offset + options.limit);
  const start = page.length === 0 ? 0 : options.offset + 1;
  const end = options.offset + page.length;
  const header = `Processes: ${processes.length} total. Showing ${start}-${end}.`;

  const rows = page.map((processInfo) => {
    const fields = [
      `PID: ${processInfo.pid}`,
      processInfo.ppid === undefined ? null : `PPID: ${processInfo.ppid}`,
      processInfo.user ? `User: ${processInfo.user}` : null,
      `Command: ${processInfo.command}`,
      `CPU: ${processInfo.cpu}`,
      `Memory: ${processInfo.memory}`,
      processInfo.runtime ? `Runtime: ${processInfo.runtime}` : null,
      options.includeArgs && processInfo.args
        ? `Args: ${redactProcessArgs(processInfo.args)}`
        : null,
    ].filter((field): field is string => Boolean(field));

    return fields.join(', ');
  });

  return [header, ...rows].join('\n');
}

export async function listProcesses(args: unknown = {}): Promise<ServerResult> {
  const parsed = ListProcessesArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{
        type: 'text',
        text: `Error: Invalid arguments for list_processes: ${parsed.error}`,
      }],
      isError: true,
    };
  }

  try {
    const options = parsed.data;
    const processes = await listPlatformProcesses(process.platform, options.includeArgs);
    return {
      content: [{ type: 'text', text: formatProcessList(processes, options) }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: Failed to list processes: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

export async function killProcess(args: unknown): Promise<ServerResult> {
  const parsed = KillProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `Error: Invalid arguments for kill_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    process.kill(parsed.data.pid);
    return {
      content: [{ type: 'text', text: `Successfully terminated process ${parsed.data.pid}` }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: Failed to kill process: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}
