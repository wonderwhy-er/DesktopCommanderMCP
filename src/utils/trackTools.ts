import * as fs from 'fs';
import * as path from 'path';
import { TOOL_CALL_FILE, TOOL_CALL_FILE_MAX_SIZE } from '../config.js';

// Ensure the directory for the log file exists
const logDir = path.dirname(TOOL_CALL_FILE);
await fs.promises.mkdir(logDir, { recursive: true });

const LOG_FILE_MODE = 0o600;

const REDACTED_KEY_FRAGMENTS = [
  'command',
  'cmd',
  'args',
  'arguments',
  'content',
  'filetext',
  'text',
  'body',
  'input',
  'markdown',
  'message',
  'value',
  'val',
  'newstring',
  'oldstring',
  'env',
  'environment',
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'key',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
];

function normalizeArgumentKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function shouldRedactArgument(key: string): boolean {
  const normalized = normalizeArgumentKey(key);
  return REDACTED_KEY_FRAGMENTS.some(fragment => normalized.includes(fragment));
}

function redactionMarker(value: unknown): string {
  let length = 0;
  if (typeof value === 'string') {
    length = value.length;
  } else if (value !== null && value !== undefined) {
    try {
      length = JSON.stringify(value)?.length ?? 0;
    } catch {
      length = 0;
    }
  }
  return `[REDACTED:${typeof value}:${length}chars]`;
}

/**
 * Return a copy of tool arguments with command, content, and credential values
 * replaced while retaining non-sensitive metadata for audit troubleshooting.
 */
export function sanitizeArgsForLog(args: unknown): unknown {
  if (args === null || args === undefined || typeof args !== 'object') {
    return args;
  }
  if (Array.isArray(args)) {
    return args.map(sanitizeArgsForLog);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (shouldRedactArgument(key)) {
      sanitized[key] = redactionMarker(value);
    } else {
      sanitized[key] = sanitizeArgsForLog(value);
    }
  }
  return sanitized;
}

async function ensureLogFilePermissions(): Promise<void> {
  const handle = await fs.promises.open(TOOL_CALL_FILE, 'a', LOG_FILE_MODE);
  await handle.close();
  await fs.promises.chmod(TOOL_CALL_FILE, LOG_FILE_MODE);
}

// Tighten permissions on an existing log before any new entries are written.
// A failure here must not prevent the server from starting; each write retries
// the check and is skipped by the existing error path if it still cannot be secured.
try {
  await ensureLogFilePermissions();
} catch (error) {
  console.error(`Error securing tool-call log: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Track tool calls and save them to a log file
 * @param toolName Name of the tool being called
 * @param args Arguments passed to the tool (optional)
 */
export async function trackToolCall(toolName: string, args?: unknown): Promise<void> {
  try {
    // Get current timestamp
    const timestamp = new Date().toISOString();
    
    // Format the log entry without persisting command text, file contents, or credentials.
    const safeArgs = args != null ? sanitizeArgsForLog(args) : null;
    const logEntry = `${timestamp} | ${toolName.padEnd(20, ' ')}${safeArgs ? `\t| Arguments: ${JSON.stringify(safeArgs)}` : ''}\n`;

    await ensureLogFilePermissions();

    // Check if file exists and get its size
    let fileSize = 0;
    
    try {
      const stats = await fs.promises.stat(TOOL_CALL_FILE);
      fileSize = stats.size;
    } catch (err) {
      // File doesn't exist yet, size remains 0
    }
    
    // If file size is 10MB or larger, rotate the log file
    if (fileSize >= TOOL_CALL_FILE_MAX_SIZE) {
      const fileExt = path.extname(TOOL_CALL_FILE);
      const fileBase = path.basename(TOOL_CALL_FILE, fileExt);
      const dirName = path.dirname(TOOL_CALL_FILE);
      
      // Create a timestamp-based filename for the old log
      const date = new Date();
      const rotateTimestamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
      const newFileName = path.join(dirName, `${fileBase}_${rotateTimestamp}${fileExt}`);
      
      // Rename the current file
      await fs.promises.rename(TOOL_CALL_FILE, newFileName);
    }
    
    // Append to log file (if file was renamed, this will create a new file)
    await fs.promises.appendFile(TOOL_CALL_FILE, logEntry, {
      encoding: 'utf8',
      mode: LOG_FILE_MODE,
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const { capture } = await import('./capture.js');
        
    // Send a final telemetry event noting that the user has opted out
    // This helps us track opt-out rates while respecting the user's choice
    await capture('server_track_tool_call_error', {
      error: errorMessage,
      toolName
    });    
    // Don't let logging errors affect the main functionality
    console.error(`Error logging tool call: ${error instanceof Error ? error.message : String(error)}`);
  }
}
