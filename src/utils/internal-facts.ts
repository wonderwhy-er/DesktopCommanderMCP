import type { ServerResult } from '../types.js';

/**
 * Tools whose structuredContent is for Desktop Commander's own code and tests
 * only: fixes added it next to the text, and a client must keep receiving what
 * it received before (no new information in tool results). It is dropped here,
 * before the result is recorded in the tool-call history or sent. Tools that
 * already sent structuredContent (the read_file/edit widgets, get_config) are
 * not listed and keep it.
 */
const INTERNAL_STRUCTURED_CONTENT_TOOLS = new Set<string>([
  'write_pdf',
]);

/** The result as the client receives it: without structuredContent kept internal */
export function withoutInternalFacts(toolName: string, result: ServerResult): ServerResult {
  if (!INTERNAL_STRUCTURED_CONTENT_TOOLS.has(toolName) || !('structuredContent' in result)) return result;
  const { structuredContent: _internal, ...sent } = result;
  return sent as ServerResult;
}
