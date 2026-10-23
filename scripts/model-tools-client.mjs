import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isModelVisibleTool } from './model-visible-tools.mjs';

/** Real MCP handshake; wait for initialized before tools/list (no fixed sleep). */
export async function listModelVisibleServerTools(serverPath) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath], stderr: 'pipe',
  });
  const client = new Client({ name: 'validate-tools-sync', version: '1.0.0' }, { capabilities: {} });
  let timeoutId;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('MCP initialize/tools-list timed out after 30s')), 30000);
  });
  try {
    await Promise.race([client.connect(transport), deadline]);
    const response = await Promise.race([client.listTools(), deadline]);
    return response.tools.filter(isModelVisibleTool).map(tool => tool.name).sort();
  } finally {
    clearTimeout(timeoutId);
    try { await client.close(); } catch { /* already disconnected */ }
  }
}
