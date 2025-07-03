import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from "express";
import { Request, Response } from "express";
import { server } from './server.js';

export async function runHttpServer(port: number): Promise<void> {
  // We return a new promise that never resolves to keep the server alive.
  return new Promise((resolve, reject) => {
    // Start a server based on the official @modelcontextprotocol/sdk documentation.
    const app = express();
    app.use(express.json());

    app.post('/', async (req: Request, res: Response) => {
      // In stateless mode, create a new instance of transport and server for each request
      // to ensure complete isolation. A single instance would cause request ID collisions
      // when multiple clients connect concurrently.

      try {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
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
    const httpServerInstance = app.listen(port, () => {
      console.log(`MCP Stateless Streamable HTTP Server listening on port ${port}`);
    });

    httpServerInstance.on('error', (err) => {
      console.error(`HTTP Server failed to start or encountered an error: ${err.message}`);
      reject(err);
    });
  });
}
