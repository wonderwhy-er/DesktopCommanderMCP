#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const fetch = require('cross-fetch');

class LocalMCPAgent {
  constructor(serverUrl, deviceToken) {
    this.serverUrl = serverUrl;
    this.deviceToken = deviceToken;
    this.sseUrl = `${serverUrl}/sse?deviceToken=${encodeURIComponent(deviceToken)}`;
    this.isConnected = false;
    this.eventSource = null;
    this.processManager = new Map(); // Track running processes
  }

  async start() {
    console.log('🚀 Starting Local MCP Agent...');
    console.log(`🔗 Server URL: ${this.serverUrl}`);
    console.log(`🔑 Device Token: ${this.deviceToken.substring(0, 20)}...`);
    
    await this.connectSSE();
  }

  async connectSSE() {
    try {
      console.log(`📡 Connecting to SSE endpoint: ${this.sseUrl}`);
      
      // Use fetch with streaming for Node.js
      const response = await fetch(this.sseUrl, {
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      console.log('✅ SSE connection established');
      this.isConnected = true;

      // Process the stream using Node.js readable stream
      let buffer = '';

      // Handle the response body as a Node.js readable stream
      response.body.on('data', (chunk) => {
        if (!this.isConnected) return;
        
        buffer += chunk.toString();
        
        // Process complete SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let eventType = null;
        let eventData = '';

        for (const line of lines) {
          if (line.trim()) {
            console.log(`📨 SSE line received: "${line}"`);
          }
          
          if (line.startsWith('event: ')) {
            eventType = line.substring(7);
            console.log(`🎯 Event type: ${eventType}`);
          } else if (line.startsWith('data: ')) {
            eventData = line.substring(6);
            console.log(`📦 Event data: ${eventData}`);
            
            // Process immediately when we have both type and data
            if (eventType && eventData) {
              console.log(`✅ Processing immediate SSE event: ${eventType}`);
              this.handleSSEEvent(eventType, eventData);
              eventType = null;
              eventData = '';
            }
          } else if (line === '') {
            // Empty line indicates end of event (backup)
            if (eventType && eventData) {
              console.log(`✅ Processing complete SSE event: ${eventType}`);
              this.handleSSEEvent(eventType, eventData);
              eventType = null;
              eventData = '';
            }
          }
        }
      });

      response.body.on('end', () => {
        console.log('🔌 SSE stream ended');
        this.isConnected = false;
      });

      response.body.on('error', (error) => {
        console.error('❌ SSE stream error:', error.message);
        this.isConnected = false;
      });
    } catch (error) {
      console.error('❌ SSE connection error:', error.message);
      this.isConnected = false;
      
      // Retry after 5 seconds
      setTimeout(() => {
        if (!this.isConnected) {
          console.log('🔄 Retrying SSE connection...');
          this.connectSSE();
        }
      }, 5000);
    }
  }

  handleSSEEvent(eventType, eventData) {
    try {
      const data = JSON.parse(eventData);
      
      switch (eventType) {
        case 'connected':
          console.log('🎉 Connected to Remote MCP Server');
          console.log(`📱 Device ID: ${data.deviceId}`);
          break;
          
        case 'mcp_request':
          console.log(`🔧 Received MCP request: ${data.request.method}`);
          this.handleMCPRequest(data.id, data.request);
          break;
          
        case 'heartbeat':
          // Silent heartbeat
          break;
          
        default:
          console.log(`📨 Unknown event: ${eventType}`, data);
      }
    } catch (error) {
      console.error('❌ Error processing SSE event:', error);
    }
  }

  async handleMCPRequest(requestId, request) {
    try {
      console.log(`   Method: ${request.method}`);
      console.log(`   Params:`, request.params);

      let result;
      
      switch (request.method) {
        case 'read_file':
          result = await this.readFile(request.params);
          break;
          
        case 'list_directory':
          result = await this.listDirectory(request.params);
          break;
          
        case 'get_file_info':
          result = await this.getFileInfo(request.params);
          break;
          
        case 'start_process':
          result = await this.startProcess(request.params);
          break;
          
        case 'write_file':
          result = await this.writeFile(request.params);
          break;
          
        case 'create_directory':
          result = await this.createDirectory(request.params);
          break;
          
        case 'move_file':
          result = await this.moveFile(request.params);
          break;
          
        default:
          throw new Error(`Unsupported MCP method: ${request.method}`);
      }

      // Send successful response
      await this.sendResponse(requestId, {
        jsonrpc: '2.0',
        id: request.id,
        result: result
      });

      console.log(`✅ MCP request ${request.method} completed successfully`);
      
    } catch (error) {
      console.error(`❌ MCP request ${request.method} failed:`, error.message);
      
      // Send error response
      await this.sendError(requestId, error.message);
    }
  }

  async readFile(params) {
    const { path: filePath, offset = 0, length = 1000 } = params;
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    let resultLines;
    if (offset < 0) {
      // Negative offset: read from end
      resultLines = lines.slice(offset);
    } else {
      // Positive offset: read from position
      resultLines = lines.slice(offset, offset + length);
    }
    
    return {
      content: resultLines.join('\n'),
      lineCount: lines.length,
      totalLines: lines.length,
      offset: offset,
      length: resultLines.length
    };
  }

  async listDirectory(params) {
    const { path: dirPath, depth = 2 } = params;
    
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }
    
    const result = [];
    
    const readDir = (currentPath, currentDepth) => {
      if (currentDepth > depth) return;
      
      const items = fs.readdirSync(currentPath);
      
      for (const item of items) {
        const itemPath = path.join(currentPath, item);
        const stats = fs.statSync(itemPath);
        
        const fileInfo = {
          name: item,
          path: itemPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.isFile() ? stats.size : undefined,
          lastModified: stats.mtime.toISOString(),
          permissions: '0' + (stats.mode & parseInt('777', 8)).toString(8)
        };
        
        result.push(fileInfo);
        
        if (stats.isDirectory() && currentDepth < depth) {
          readDir(itemPath, currentDepth + 1);
        }
      }
    };
    
    readDir(dirPath, 1);
    
    return {
      path: dirPath,
      files: result,
      count: result.length
    };
  }

  async getFileInfo(params) {
    const { path: filePath } = params;
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    const stats = fs.statSync(filePath);
    
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size,
      type: stats.isDirectory() ? 'directory' : 'file',
      lastModified: stats.mtime.toISOString(),
      created: stats.birthtime.toISOString(),
      permissions: '0' + (stats.mode & parseInt('777', 8)).toString(8),
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile()
    };
  }

  async startProcess(params) {
    const { command, timeout_ms = 30000, shell = true } = params;
    
    try {
      const result = execSync(command, {
        encoding: 'utf8',
        timeout: timeout_ms,
        shell: shell,
        maxBuffer: 1024 * 1024 // 1MB buffer
      });
      
      return {
        output: result,
        exitCode: 0,
        command: command,
        executionTime: Date.now() // Approximate
      };
    } catch (error) {
      return {
        output: error.stdout || error.stderr || error.message,
        exitCode: error.status || 1,
        command: command,
        error: error.message,
        executionTime: Date.now()
      };
    }
  }

  async writeFile(params) {
    const { path: filePath, content, mode = 'rewrite' } = params;
    
    if (mode === 'append') {
      fs.appendFileSync(filePath, content, 'utf8');
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    
    const stats = fs.statSync(filePath);
    
    return {
      path: filePath,
      size: stats.size,
      lastModified: stats.mtime.toISOString(),
      mode: mode
    };
  }

  async createDirectory(params) {
    const { path: dirPath } = params;
    
    fs.mkdirSync(dirPath, { recursive: true });
    
    return {
      path: dirPath,
      created: new Date().toISOString()
    };
  }

  async moveFile(params) {
    const { source, destination } = params;
    
    fs.renameSync(source, destination);
    
    return {
      source: source,
      destination: destination,
      moved: new Date().toISOString()
    };
  }

  async sendResponse(requestId, response) {
    try {
      await fetch(`${this.serverUrl}/sse/response`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deviceToken: this.deviceToken,
          requestId: requestId,
          response: response
        })
      });
    } catch (error) {
      console.error('Failed to send response:', error);
    }
  }

  async sendError(requestId, errorMessage) {
    try {
      await fetch(`${this.serverUrl}/sse/error`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deviceToken: this.deviceToken,
          requestId: requestId,
          error: errorMessage
        })
      });
    } catch (error) {
      console.error('Failed to send error:', error);
    }
  }

  stop() {
    console.log('🛑 Stopping Local MCP Agent...');
    this.isConnected = false;
    if (this.eventSource) {
      this.eventSource.close();
    }
  }
}

// CLI Usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node agent.js <SERVER_URL> <DEVICE_TOKEN>');
    console.error('Example: node agent.js http://localhost:3002 eyJhbGciOiJIUzI1NiI...');
    process.exit(1);
  }

  const [serverUrl, deviceToken] = args;
  const agent = new LocalMCPAgent(serverUrl, deviceToken);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\\n📴 Received SIGINT, shutting down gracefully...');
    agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\\n📴 Received SIGTERM, shutting down gracefully...');
    agent.stop();
    process.exit(0);
  });

  agent.start().catch(error => {
    console.error('💥 Agent failed to start:', error);
    process.exit(1);
  });
}