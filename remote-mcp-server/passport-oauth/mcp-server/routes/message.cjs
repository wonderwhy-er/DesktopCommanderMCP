/**
 * MCP Message Handling Routes
 */

const express = require('express');
const router = express.Router();
const { requireScope } = require('../middleware/oauth.cjs');
const fetch = require('cross-fetch');

/**
 * Setup MCP message routes
 */
function setupMessageRoutes(connectionManager) {
  
  /**
   * MCP Message Endpoint
   * POST /message
   */
  router.post('/message',
    requireScope(['mcp:tools']),
    async (req, res) => {
      try {
        const { client_id, user_id } = req.oauth;
        const mcpRequest = req.body;
        
        console.log(`[MCP] Message received from client ${client_id}:`, JSON.stringify(mcpRequest, null, 2));
        
        // Validate JSON-RPC format
        if (!mcpRequest.jsonrpc || !mcpRequest.method) {
          return res.status(400).json({
            jsonrpc: '2.0',
            id: mcpRequest.id || null,
            error: {
              code: -32600,
              message: 'Invalid Request',
              data: 'Missing required fields: jsonrpc, method'
            }
          });
        }
        
        // Forward to remote server if configured
        const remoteServerUrl = process.env.REMOTE_SERVER_URL;
        const remoteServerEndpoint = process.env.REMOTE_SERVER_ENDPOINT || '/api/mcp/execute';
        
        if (remoteServerUrl) {
          try {
            console.log(`[MCP] Forwarding request to remote server: ${remoteServerUrl}${remoteServerEndpoint}`);
            
            const remoteResponse = await fetch(`${remoteServerUrl}${remoteServerEndpoint}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${req.oauth.access_token}`
              },
              body: JSON.stringify(mcpRequest)
            });
            
            if (!remoteResponse.ok) {
              throw new Error(`Remote server error: ${remoteResponse.status}`);
            }
            
            const remoteResult = await remoteResponse.json();
            console.log(`[MCP] Remote server response:`, JSON.stringify(remoteResult, null, 2));
            
            return res.json(remoteResult);
            
          } catch (error) {
            console.error('[MCP] Remote server forwarding failed:', error);
            
            return res.json({
              jsonrpc: '2.0',
              id: mcpRequest.id || null,
              error: {
                code: -32603,
                message: 'Internal error',
                data: `Remote server unavailable: ${error.message}`
              }
            });
          }
        }
        
        // Handle locally if no remote server
        const response = await handleMCPRequestLocally(mcpRequest, req.oauth);
        res.json(response);
        
      } catch (error) {
        console.error('[MCP] Message handling error:', error);
        
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id || null,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
          }
        });
      }
    }
  );

  /**
   * MCP Tools List Endpoint
   * GET /tools
   */
  router.get('/tools',
    requireScope(['mcp:tools']),
    async (req, res) => {
      try {
        const { client_id } = req.oauth;
        
        console.log(`[MCP] Tools list requested by client ${client_id}`);
        
        // Forward to remote server if configured
        const remoteServerUrl = process.env.REMOTE_SERVER_URL;
        
        if (remoteServerUrl) {
          try {
            const toolsResponse = await fetch(`${remoteServerUrl}/api/mcp/tools`, {
              headers: {
                'Authorization': `Bearer ${req.oauth.access_token}`,
                'Content-Type': 'application/json'
              }
            });
            
            if (toolsResponse.ok) {
              const tools = await toolsResponse.json();
              return res.json(tools);
            }
          } catch (error) {
            console.error('[MCP] Remote tools fetch failed:', error);
          }
        }
        
        // Return local tools if remote unavailable
        res.json({
          tools: [
            {
              name: 'echo',
              description: 'Echo back the input text',
              inputSchema: {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    description: 'Text to echo back'
                  }
                },
                required: ['text']
              }
            },
            {
              name: 'oauth_info',
              description: 'Get OAuth token information',
              inputSchema: {
                type: 'object',
                properties: {},
                required: []
              }
            }
          ]
        });
        
      } catch (error) {
        console.error('[MCP] Tools list error:', error);
        res.status(500).json({
          error: 'server_error',
          message: 'Failed to fetch tools list'
        });
      }
    }
  );

  /**
   * MCP Execute Tool Endpoint
   * POST /execute
   */
  router.post('/execute',
    requireScope(['mcp:tools']),
    async (req, res) => {
      try {
        const { toolName, arguments: toolArgs } = req.body;
        
        console.log(`[MCP] Tool execution: ${toolName} with args:`, toolArgs);
        
        // Create MCP request
        const mcpRequest = {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: toolArgs || {}
          }
        };
        
        // Use the message handler
        req.body = mcpRequest;
        return router.stack[0].route.stack[1].handle(req, res);
        
      } catch (error) {
        console.error('[MCP] Tool execution error:', error);
        res.status(500).json({
          error: 'execution_failed',
          message: error.message
        });
      }
    }
  );

  return router;
}

/**
 * Handle MCP request locally (fallback)
 */
async function handleMCPRequestLocally(request, oauthData) {
  const { method, params, id } = request;
  
  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              logging: {}
            },
            serverInfo: {
              name: 'mcp-oauth-server',
              version: '1.0.0'
            }
          }
        };
        
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo back the input text',
                inputSchema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'Text to echo' }
                  },
                  required: ['text']
                }
              },
              {
                name: 'oauth_info',
                description: 'Get current OAuth token information',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  required: []
                }
              }
            ]
          }
        };
        
      case 'tools/call':
        const { name, arguments: args } = params;
        
        switch (name) {
          case 'echo':
            return {
              jsonrpc: '2.0',
              id: id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Echo: ${args.text || 'No text provided'}`
                  }
                ]
              }
            };
            
          case 'oauth_info':
            return {
              jsonrpc: '2.0',
              id: id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      client_id: oauthData.client_id,
                      user_id: oauthData.user_id,
                      scope: oauthData.scope,
                      token_active: true,
                      cached: oauthData.cached || false
                    }, null, 2)
                  }
                ]
              }
            };
            
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
        
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: id,
      error: {
        code: -32601,
        message: 'Method not found',
        data: error.message
      }
    };
  }
}

module.exports = { setupMessageRoutes };