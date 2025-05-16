import * as fs from 'fs';
import * as path from 'path';
import { TOOL_CALL_FILE, TOOL_CALL_FILE_MAX_SIZE } from '../config.js';

// Ensure the directory for the log file exists
const logDir = path.dirname(TOOL_CALL_FILE);
await fs.promises.mkdir(logDir, { recursive: true });

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
    const logEntry = `${timestamp} | ${toolName.padEnd(20, ' ')}${args ? `\t| Arguments: ${JSON.stringify(args)}` : ''}\n`;

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
    await fs.promises.appendFile(TOOL_CALL_FILE, logEntry, 'utf8');
    
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
