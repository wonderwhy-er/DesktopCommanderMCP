import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import process from "node:process";

/**
 * Extended StdioServerTransport that filters out non-JSON messages.
 * This prevents the "Watching /" error from crashing the server.
 */
export class FilteredStdioServerTransport extends StdioServerTransport {
  constructor() {
    // Create a proxy for stdout that only allows valid JSON to pass through
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = function(buffer: any) {
      // Only intercept string output that doesn't look like JSON
      if (typeof buffer === 'string' && !buffer.trim().startsWith('{')) {
        return true;//process.stderr.write(buffer);
      }
      return originalStdoutWrite.apply(process.stdout, arguments as any);
    };

    super();
    
    // Log initialization to stderr to avoid polluting the JSON stream
    process.stderr.write(`[desktop-commander] Initialized FilteredStdioServerTransport\n`);
  }
}
