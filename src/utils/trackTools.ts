import * as fs from 'fs';
import * as path from 'path';
import { TOOL_CALL_FILE, TOOL_CALL_FILE_MAX_SIZE } from '../config.js';

// Ensure the directory for the log file exists
const logDir = path.dirname(TOOL_CALL_FILE);
await fs.promises.mkdir(logDir, { recursive: true });

const REDACTED_ARGUMENT_KEYS = new Set([
  'command', 'cmd', 'args', 'arguments',
  'content', 'file_text', 'text', 'body',
  'value', 'val', 'new_string', 'old_string',
  'env', 'environment', 'password', 'passwd', 'secret',
  'token', 'access_token', 'refresh_token', 'key', 'api_key', 'apikey'
]);

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return REDACTED_ARGUMENT_KEYS.has(normalized)
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('apikey')
    || normalized.includes('api_key');
}

function valueLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export function sanitizeArgsForLog(args: unknown): unknown {
  if (args === null || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map(sanitizeArgsForLog);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    sanitized[key] = shouldRedactKey(key)
      ? `[REDACTED:${typeof value}:${valueLength(value)}chars]`
      : sanitizeArgsForLog(value);
  }
  return sanitized;
}

export async function ensureLogFilePermissions(filePath = TOOL_CALL_FILE): Promise<void> {
  const handle = await fs.promises.open(filePath, 'a', 0o600);
  await handle.close();
  await fs.promises.chmod(filePath, 0o600);
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
    
    // Format the log entry
    const safeArgs = args === undefined ? undefined : sanitizeArgsForLog(args);
    const logEntry = `${timestamp} | ${toolName.padEnd(20, ' ')}${safeArgs !== undefined ? `\t| Arguments: ${JSON.stringify(safeArgs)}` : ''}\n`;

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

    await ensureLogFilePermissions();
    
    // Append to log file (if file was renamed, this will create a new file)
    await fs.promises.appendFile(TOOL_CALL_FILE, logEntry, { encoding: 'utf8', mode: 0o600 });
    
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
