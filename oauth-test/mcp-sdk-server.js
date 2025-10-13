import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Create MCP server
const server = new Server(
  {
    name: 'Desktop Commander OAuth Test',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error('📋 Tools list requested');
  return {
    tools: [
      {
        name: 'get_user_info',
        description: 'Get authenticated user information',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'echo',
        description: 'Echo back a message',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Message to echo',
            },
          },
          required: ['message'],
        },
      },
    ],
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.error(`🛠️  Tool called: ${request.params.name}`);
  
  if (request.params.name === 'get_user_info') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            username: 'anonymous',
            mode: 'testing',
            message: '⚠️  Running without auth (testing mode)',
          }, null, 2),
        },
      ],
    };
  }
  
  if (request.params.name === 'echo') {
    return {
      content: [
        {
          type: 'text',
          text: `Echo: ${request.params.arguments.message}`,
        },
      ],
    };
  }
  
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ MCP SDK Server running');
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
