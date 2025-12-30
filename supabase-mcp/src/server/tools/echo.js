/**
 * Simple echo tool for testing MCP functionality
 */
export class EchoTool {
  static getDefinition() {
    return {
      name: 'echo',
      description: 'Echo back the input text with optional formatting',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to echo back'
          },
          uppercase: {
            type: 'boolean',
            description: 'Convert text to uppercase',
            default: false
          },
          prefix: {
            type: 'string',
            description: 'Prefix to add to the text',
            default: 'Echo: '
          }
        },
        required: ['text']
      }
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