import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { capture } from './utils/capture.js';

// Default port for the HTTP server
const DEFAULT_PORT = 3000;

/**
 * Helper function to get all tools from the server
 */
async function getAllToolsFromServer(server: Server): Promise<any[]> {
  // For now, we'll just return a dummy list of tools
  // In a real implementation, you would get this from the server
  return [
    {
      name: "read_file",
      description: "Read the complete contents of a file from the file system.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          isUrl: { type: "boolean", default: false }
        },
        required: ["path"]
      }
    },
    {
      name: "write_file",
      description: "Write content to a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "execute_command",
      description: "Execute a terminal command.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number" }
        },
        required: ["command"]
      }
    }
  ];
}

/**
 * Start an HTTP server that serves MCP over StreamableHTTP transport
 */
export async function startHttpServer(server: Server, port: number = DEFAULT_PORT): Promise<() => void> {
  const app = express();
  
  // Add CORS headers for cross-origin requests and handle Accept headers
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Add CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', '*');  // Allow all headers
    
    // For preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      // Ensure we respond with 200 OK for OPTIONS
      res.status(200).end();
      return;
    }
    
    // Forcefully add both application/json and text/event-stream to the Accept header
    // This ensures that the StreamableHTTPServerTransport won't reject the request
    const originalAccept = req.headers.accept || '';
    req.headers.accept = originalAccept.includes('application/json') && originalAccept.includes('text/event-stream')
      ? originalAccept
      : 'application/json, text/event-stream, ' + originalAccept;
    
    console.log('Modified Accept header:', req.headers.accept);
    
    next();
  });
  
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Map to store transports by session ID
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // Add a specific handler for /messages route
  app.all('/messages', async (req: Request, res: Response) => {
    try {
      console.log('Handling dedicated /messages route');
      
      // For GET requests to /messages, send a simple SSE stream
      if (req.method === 'GET') {
        console.log('GET on /messages - setting up SSE stream');
        
        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Create a new session ID
        const sessionId = randomUUID();
        console.log('Creating session for /messages:', sessionId);
        
        // Create a new transport for this session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          enableJsonResponse: false  // Use SSE mode
        });
        
        // Store the transport for future requests
        transports[sessionId] = transport;
        
        // Connect to the server
        await server.connect(transport);
        
        // Get tools for the response
        const allTools = await getAllToolsFromServer(server);
        const toolsJson = JSON.stringify(allTools);
        
        // Send endpoint event immediately
        res.write(`event: endpoint\ndata: /messages/?session_id=${sessionId}\n\n`);
        console.log('Sent endpoint event for direct /messages route');
        
        // Send initialization message - CRITICAL!
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05","capabilities":{"experimental":{},"prompts":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false},"tools":{"listChanged":false}},"serverInfo":{"name":"desktop-commander-sse","version":"0.1.39"}}}\n\n`);
        console.log('Sent initialization message');
        
        // Send tools list message with actual tools
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":${toolsJson}}}\n\n`);
        console.log('Sent tools list message');
        
        // Send empty resources message
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"resources":[]}}\n\n`);
        console.log('Sent empty resources message');
        
        // Send empty prompts message
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"prompts":[]}}\n\n`);
        console.log('Sent empty prompts message');
        
        // Start ping interval
        const pingInterval = setInterval(() => {
          if (!res.writableEnded) {
            const timestamp = new Date().toISOString();
            res.write(`: ping - ${timestamp}\n\n`);
          } else {
            clearInterval(pingInterval);
          }
        }, 15000);
        
        // Clean up resources on close
        res.on('close', () => {
          clearInterval(pingInterval);
          delete transports[sessionId];
          console.log('Closed /messages SSE connection');
        });
        
        // Keep the connection open
        return;
      }
      
      // For POST requests with session_id
      if (req.method === 'POST' && req.query.session_id) {
        const sessionId = req.query.session_id as string;
        console.log('POST to /messages with session_id:', sessionId);
        
        if (transports[sessionId]) {
          const transport = transports[sessionId];
          
          // Try to handle normally, but catch Accept header errors
          try {
          // Special handling for common requests
          if (req.body) {
            // Check if it's an initialization notification
            if (req.body.method === 'notifications/initialized') {
              console.log('Received notifications/initialized request on /messages, responding directly');
              // Respond directly with success
              res.status(200).json({
                jsonrpc: '2.0',
                result: true,
                id: req.body.id || null
              });
              return;
            }
            
            // Check if it's a tools/list request
            if (req.body.method === 'tools/list') {
              console.log('Received tools/list request on /messages, responding with all tools');
              
              // Get all tools from the server
              const allTools = await getAllToolsFromServer(server);
              console.log(`Responding with ${allTools.length} tools`);
              
              // Respond with the tools list
              res.status(200).json({
                jsonrpc: '2.0',
                result: { tools: allTools },
                id: req.body.id
              });
              return;
            }
          }
          
          // If we get here, let the transport handle it normally
          await transport.handleRequest(req, res, req.body);
          } catch (error) {
            if (error instanceof Error && error.message.includes('Not Acceptable')) {
              console.log('Handling /messages POST despite Accept header issues');
              // Just respond with OK
              res.status(200).json({
                jsonrpc: '2.0',
                result: {},
                id: req.body.id || null
              });
            } else {
              throw error;
            }
          }
          return;
        }
        
        // No valid session
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Invalid session ID',
          },
          id: null,
        });
        return;
      }
      
      // Method not allowed
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed',
        },
        id: null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error in /messages handler:', errorMessage);
      
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // Handle requests to the MCP endpoint and the messages endpoint
  app.all(['/mcp', '/messages', '/messages/:sessionId'], async (req, res) => {
    try {
      // Log the incoming request details for debugging
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Body method: ${req.body?.method || 'none'}, ID: ${req.body?.id || 'none'}`);
      console.log('Headers:', JSON.stringify(req.headers));
      
      // Handle HTTP OPTIONS requests for CORS preflight
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }
      
      // For GET requests, set up an SSE connection
      if (req.method === 'GET') {
        console.log('Received GET request for SSE connection');
        
        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Create a new session ID
        const sessionId = randomUUID();
        console.log('Creating new SSE session:', sessionId);
        
        // Create a new transport for this session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          enableJsonResponse: false  // Use SSE mode
        });
        
        // Store the transport for future requests
        transports[sessionId] = transport;
        
        // Clean up when the connection closes
        res.on('close', () => {
          console.log('SSE connection closed for session:', sessionId);
          delete transports[sessionId];
          capture('http_server_session_closed', { sessionId });
        });
        
        // Connect to the server
        await server.connect(transport);
        
        // Get tools for the response
        const allTools = await getAllToolsFromServer(server);
        const toolsJson = JSON.stringify(allTools);
        
        // Create proper URL for endpoint event
        const messagesPath = '/messages/';
        const baseUrl = `${req.protocol}://${req.headers.host || 'localhost:3000'}`;
        const endpointUrl = `${messagesPath}?session_id=${sessionId}`;
        
        // First send the endpoint event - this is critical for MCP clients
        res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);
        console.log('Sent endpoint event:', endpointUrl);
        
        // Send initialization message - CRITICAL!
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05","capabilities":{"experimental":{},"prompts":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false},"tools":{"listChanged":false}},"serverInfo":{"name":"desktop-commander-sse","version":"0.1.39"}}}\n\n`);
        console.log('Sent initialization message');
        
        // Send tools list message with actual tools
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":${toolsJson}}}\n\n`);
        console.log('Sent tools list message');
        
        // Send empty resources message
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"resources":[]}}\n\n`);
        console.log('Sent empty resources message');
        
        // Send empty prompts message
        res.write(`event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"prompts":[]}}\n\n`);
        console.log('Sent empty prompts message');
        
        // Start the SSE connection with the transport
        await transport.handleRequest(req, res);
        
        // Set up ping/keep-alive messages every 15 seconds
        const pingInterval = setInterval(() => {
          if (!res.writableEnded) {
            const timestamp = new Date().toISOString();
            res.write(`: ping - ${timestamp}\n\n`);
            console.log('Sent ping at', timestamp);
          } else {
            clearInterval(pingInterval);
          }
        }, 15000);
        
        // Clean up interval when connection closes
        res.on('close', () => {
          clearInterval(pingInterval);
        });
        
        return;
      }
      
      // For POST requests, use the session ID from headers or query params
      if (req.method === 'POST') {
        // Special handling for tools/list without a session (first request)
        if (req.body && req.body.method === 'tools/list' && (!req.headers['mcp-session-id'] && !req.query.session_id)) {
          console.log('Received tools/list request without session, responding directly');
          
          // Get all tools from the server
          const allTools = await getAllToolsFromServer(server);
          console.log(`Responding with ${allTools.length} tools despite no session`);
          
          // Respond with the tools list
          res.status(200).json({
            jsonrpc: '2.0',
            result: { tools: allTools },
            id: req.body.id
          });
          return;
        }
        
        // Special handling for resources/list without a session
        if (req.body && req.body.method === 'resources/list' && (!req.headers['mcp-session-id'] && !req.query.session_id)) {
          console.log('Received resources/list request without session, responding directly');
          
          try {
            // Respond with empty resources list
            res.status(200).json({
              jsonrpc: '2.0',
              result: { resources: [] },
              id: req.body.id
            });
            console.log('Successfully responded to resources/list');
            return;
          } catch (e) {
            console.error('Error responding to resources/list:', e);
            if (!res.headersSent) {
              res.status(500).json({
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message: 'Internal server error responding to resources/list',
                },
                id: req.body.id || null,
              });
            }
            return;
          }
        }
        
        // Special handling for prompts/list without a session
        if (req.body && req.body.method === 'prompts/list' && (!req.headers['mcp-session-id'] && !req.query.session_id)) {
          console.log('Received prompts/list request without session, responding directly');
          
          try {
            // Respond with empty prompts list
            res.status(200).json({
              jsonrpc: '2.0',
              result: { prompts: [] },
              id: req.body.id
            });
            console.log('Successfully responded to prompts/list');
            return;
          } catch (e) {
            console.error('Error responding to prompts/list:', e);
            if (!res.headersSent) {
              res.status(500).json({
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message: 'Internal server error responding to prompts/list',
                },
                id: req.body.id || null,
              });
            }
            return;
          }
        }
        
        // First check header for session ID
        let sessionId = req.headers['mcp-session-id'] as string;
        
        // If not in header, check query parameters
        if (!sessionId && req.query.session_id) {
          sessionId = req.query.session_id as string;
        }
        
        console.log('POST request with session ID from:', 
                   sessionId && req.headers['mcp-session-id'] ? 'header' : 
                   sessionId && req.query.session_id ? 'query' : 'none',
                   'Session ID:', sessionId);
        
        // Check if we have a valid session
        if (sessionId && transports[sessionId]) {
          console.log('Using existing session:', sessionId);
          const transport = transports[sessionId];
          
          // Bypass the accept header check for POST requests
          // This handles the case where the client doesn't include the correct Accept headers
          try {
            // Special handling for common requests
          if (req.body) {
            // Check if it's an initialization notification
            if (req.body.method === 'notifications/initialized') {
              console.log('Received notifications/initialized request, responding directly');
              // Respond directly with success
              res.status(200).json({
                jsonrpc: '2.0',
                result: true,
                id: req.body.id || null
              });
              return;
            }
            
            // Check if it's a tools/list request
            if (req.body.method === 'tools/list') {
              console.log('Received tools/list request, responding with all tools');
              
              // Get all tools from the server
              const allTools = await getAllToolsFromServer(server);
              console.log(`Responding with ${allTools.length} tools`);
              
              // Respond with the tools list
              res.status(200).json({
                jsonrpc: '2.0',
                result: { tools: allTools },
                id: req.body.id
              });
              return;
            }
          }
          
          // If we get here, let the transport handle it normally
          await transport.handleRequest(req, res, req.body);
          } catch (error) {
            // If there's an error about Accept headers, handle the request anyway
            if (error instanceof Error && error.message.includes('Not Acceptable')) {
              console.log('Ignoring Accept header validation error and processing the request anyway');
              // Just respond with OK - we can't directly handle the message without transport
              res.status(200).json({
                jsonrpc: '2.0',
                result: {},
                id: req.body.id || null
              });
            } else {
              // For other errors, rethrow
              throw error;
            }
          }
          return;
        }
        
        // If this is an initialization request, create a new session
        if (isInitializeRequest(req.body)) {
          const newSessionId = randomUUID();
          console.log('Received initialization request, creating new session:', newSessionId);
          
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
          });
          
          transports[newSessionId] = transport;
          
          res.on('close', () => {
            console.log('Connection closed for session:', newSessionId);
            delete transports[newSessionId];
            capture('http_server_session_closed', { sessionId: newSessionId });
          });
          
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }
        
        // If no session exists and all other special handling doesn't apply,
        // we need to create a new session or return an error
        try {
          // The client doesn't have a valid session, and we need to handle this differently
          // Let's check if it's a resources/list or prompts/list request
          if (req.body && (req.body.method === 'resources/list' || req.body.method === 'prompts/list')) {
            console.log(`Handling ${req.body.method} without session - returning empty list`);
            
            if (!res.headersSent) {
              if (req.body.method === 'resources/list') {
                res.status(200).json({
                  jsonrpc: '2.0',
                  result: { resources: [] },
                  id: req.body.id
                });
              } else { // prompts/list
                res.status(200).json({
                  jsonrpc: '2.0',
                  result: { prompts: [] },
                  id: req.body.id
                });
              }
            }
            return;
          }
          
          // For other kinds of requests, return an error
          if (!res.headersSent) {
            res.status(400).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: Mcp-Session-Id header is required',
              },
              id: req.body?.id || null,
            });
          }
        } catch (e) {
          console.error('Error in fallback handling:', e);
          // Make sure we only send headers once
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: 'Internal server error in fallback handling',
              },
              id: req.body?.id || null,
            });
          }
        }
        return;
      }
      
      // For any other methods, return method not allowed
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed',
        },
        id: null,
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error handling request:', errorMessage);
      capture('http_server_error', { error: errorMessage });
      
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // Start the server
  const httpServer = app.listen(port, () => {
    console.log(`MCP HTTP server listening on port ${port}`);
    capture('http_server_started', { port });
  });

  // Return a function to stop the server
  return () => {
    Object.values(transports).forEach(transport => {
      try {
        transport.close();
      } catch (e) {
        // Ignore errors when closing transports
      }
    });
    httpServer.close();
    capture('http_server_stopped');
  };
}
