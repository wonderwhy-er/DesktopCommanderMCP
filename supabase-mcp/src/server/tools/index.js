import { EchoTool } from './echo.js';
import { UserInfoTool } from './user-info.js';

/**
 * Registry of all available MCP tools
 */
export const TOOLS = {
  echo: EchoTool,
  user_info: UserInfoTool,
};

/**
 * Get all tool definitions
 */
export function getAllToolDefinitions() {
  return Object.values(TOOLS).map(tool => tool.getDefinition());
}

/**
 * Get specific tool by name
 */
export function getTool(name) {
  const tool = TOOLS[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool;
}

/**
 * Execute a tool with given parameters
 */
export async function executeTool(name, params, user, supabase) {
  const tool = getTool(name);
  return await tool.execute(params, user, supabase);
}