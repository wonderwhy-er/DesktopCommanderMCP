import { ServerResult } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ToolCallRecord {
  timestamp: string;
  toolName: string;
  arguments: any;
  output: ServerResult;
  duration?: number;
}

interface FormattedToolCallRecord extends Omit<ToolCallRecord, 'timestamp'> {
  timestamp: string; // formatted local time string
}

// Format timestamp in local timezone for display
function formatLocalTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

class ToolHistory {
  private history: ToolCallRecord[] = [];
  private readonly MAX_ENTRIES = 1000;
  private readonly historyFile: string;
  private writeQueue: ToolCallRecord[] = [];
  private isWriting = false;
  private writeInterval?: NodeJS.Timeout;

  constructor() {
    // Store history in same directory as config to keep everything together
    const historyDir = path.join(os.homedir(), '.claude-server-commander');
    
    // Ensure directory exists
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }
    
    // Use append-only JSONL format (JSON Lines)
    this.historyFile = path.join(historyDir, 'tool-history.jsonl');
    
    // Load existing history on startup
    this.loadFromDisk();
    
    // Start async write processor
    this.startWriteProcessor();
  }

  /**
   * Load history from disk (all instances share the same file)
   */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.historyFile)) {
        return;
      }

      const content = fs.readFileSync(this.historyFile, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      // Parse each line as JSON
      const records: ToolCallRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch (e) {
          // Silently skip invalid lines
        }
      }

      // Keep only last 1000 entries
      this.history = records.slice(-this.MAX_ENTRIES);

      // If file is getting too large, trim it
      if (lines.length > this.MAX_ENTRIES * 2) {
        this.trimHistoryFile();
      }
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Trim history file to prevent it from growing indefinitely
   */
  private trimHistoryFile(): void {
    try {
      // Keep last 1000 entries in memory
      const keepEntries = this.history.slice(-this.MAX_ENTRIES);

      // Write them back
      const lines = keepEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.writeFileSync(this.historyFile, lines, 'utf-8');
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Async write processor - batches writes to avoid blocking
   */
  private startWriteProcessor(): void {
    this.writeInterval = setInterval(() => {
      if (this.writeQueue.length > 0 && !this.isWriting) {
        this.flushToDisk();
      }
    }, 1000); // Flush every second
    
    // Prevent interval from keeping process alive during shutdown/tests
    this.writeInterval.unref();
  }

  /**
   * Flush queued writes to disk
   */
  private async flushToDisk(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) return;
    
    this.isWriting = true;
    const toWrite = [...this.writeQueue];
    this.writeQueue = [];
    
    try {
      // Append to file (atomic append operation)
      const lines = toWrite.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.appendFileSync(this.historyFile, lines, 'utf-8');
    } catch (error) {
      // Put back in queue on failure
      this.writeQueue.unshift(...toWrite);
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * Add a tool call to history
   */
  addCall(
    toolName: string, 
    args: any, 
    output: ServerResult, 
    duration?: number
  ): void {
    const record: ToolCallRecord = {
      timestamp: new Date().toISOString(),
      toolName,
      arguments: args,
      output,
      duration
    };

    this.history.push(record);

    // Keep only last 1000 in memory
    if (this.history.length > this.MAX_ENTRIES) {
      this.history.shift();
    }
    
    // Queue for async write
    this.writeQueue.push(record);
  }

  /**
   * Get recent tool calls with filters
   */
  getRecentCalls(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): ToolCallRecord[] {
    let results = [...this.history];

    // Filter by tool name
    if (options.toolName) {
      results = results.filter(r => r.toolName === options.toolName);
    }

    // Filter by timestamp
    if (options.since) {
      const sinceDate = new Date(options.since);
      results = results.filter(r => new Date(r.timestamp) >= sinceDate);
    }

    // Limit results (default 50, max 1000)
    const limit = Math.min(options.maxResults || 50, 1000);
    return results.slice(-limit);
  }

  /**
   * Get recent calls formatted with local timezone
   */
  getRecentCallsFormatted(options: {
    maxResults?: number;
    toolName?: string;
    since?: string;
  }): FormattedToolCallRecord[] {
    const calls = this.getRecentCalls(options);
    
    // Format timestamps to local timezone
    return calls.map(call => ({
      ...call,
      timestamp: formatLocalTimestamp(call.timestamp)
    }));
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      totalEntries: this.history.length,
      oldestEntry: this.history[0]?.timestamp,
      newestEntry: this.history[this.history.length - 1]?.timestamp,
      historyFile: this.historyFile,
      queuedWrites: this.writeQueue.length
    };
  }

  /**
   * Cleanup method - clears interval and flushes pending writes
   * Call this during shutdown or in tests
   */
  async cleanup(): Promise<void> {
    // Clear the interval
    if (this.writeInterval) {
      clearInterval(this.writeInterval);
      this.writeInterval = undefined;
    }
    
    // Flush any remaining writes
    if (this.writeQueue.length > 0) {
      await this.flushToDisk();
    }
  }
}

export const toolHistory = new ToolHistory();
