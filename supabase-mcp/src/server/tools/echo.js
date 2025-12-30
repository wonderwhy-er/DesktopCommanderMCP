/**
 * Simple echo tool for testing MCP functionality
 */
import { z } from 'zod';

export class EchoTool {
  static getDefinition() {
    return {
      name: 'echo',
      description: 'Echo back the input text with optional formatting',
      inputSchema: z.object({
        text: z.string().describe('Text to echo back'),
        uppercase: z.boolean().default(false).describe('Convert text to uppercase'),
        prefix: z.string().default('Echo: ').describe('Prefix to add to the text')
      })
    };
  }

  static async execute(params, user, supabase) {
    const { text, uppercase = false, prefix = 'Echo: ' } = params;

    if (!text || typeof text !== 'string') {
      throw new Error('Text parameter is required and must be a string');
    }

    let result = prefix + text;

    if (uppercase) {
      result = result.toUpperCase();
    }

    return {
      content: [{
        type: 'text',
        text: result
      }]
    };
  }
}