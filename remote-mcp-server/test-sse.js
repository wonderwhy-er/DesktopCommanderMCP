#!/usr/bin/env node

const fetch = require('cross-fetch');

// Test SSE connection and agent interaction
class SSETest {
  constructor(serverUrl, deviceToken) {
    this.serverUrl = serverUrl;
    this.deviceToken = deviceToken;
  }

  async runTest() {
    console.log('🧪 Starting SSE Test Suite');
    console.log(`🔗 Server URL: ${this.serverUrl}`);
    console.log(`🔑 Device Token: ${this.deviceToken.substring(0, 20)}...`);
    
    try {
      await this.testSSEConnection();
      await this.testHealthCheck();
      await this.testSSEStatus();
    } catch (error) {
      console.error('❌ Test failed:', error.message);
    }
  }

  async testSSEConnection() {
    console.log('\n📡 Testing SSE Connection...');
    
    const sseUrl = `${this.serverUrl}/sse?deviceToken=${encodeURIComponent(this.deviceToken)}`;
    
    try {
      const response = await fetch(sseUrl, {
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      console.log('✅ SSE endpoint responds correctly');
      console.log(`   Status: ${response.status} ${response.statusText}`);
      console.log(`   Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
      
      // Read a few lines to test streaming
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let eventCount = 0;
      
      const timeout = setTimeout(() => {
        reader.cancel();
      }, 3000); // 3 second test
      
      try {
        while (eventCount < 3) { // Read up to 3 events
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('event:') || line.startsWith('data:')) {
              console.log(`   📨 Received: ${line}`);
              eventCount++;
            }
          }
        }
      } finally {
        clearTimeout(timeout);
        reader.cancel();
      }
      
    } catch (error) {
      console.error('❌ SSE connection test failed:', error.message);
    }
  }

  async testHealthCheck() {
    console.log('\n🩺 Testing Health Check...');
    
    try {
      const response = await fetch(`${this.serverUrl}/health`);
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      
      const health = await response.json();
      console.log('✅ Health check passed');
      console.log(`   Status: ${health.status}`);
      console.log(`   WebSocket connections: ${health.connections}`);
      console.log(`   SSE connections: ${health.sseConnections}`);
      
    } catch (error) {
      console.error('❌ Health check failed:', error.message);
    }
  }

  async testSSEStatus() {
    console.log('\n📊 Testing SSE Status Endpoint...');
    
    try {
      const response = await fetch(`${this.serverUrl}/sse/status`);
      
      if (!response.ok) {
        throw new Error(`SSE status failed: ${response.status}`);
      }
      
      const status = await response.json();
      console.log('✅ SSE status endpoint working');
      console.log(`   Connection count: ${status.connectionCount}`);
      console.log(`   Connected devices: ${JSON.stringify(status.connectedDevices)}`);
      
    } catch (error) {
      console.error('❌ SSE status test failed:', error.message);
    }
  }

  async testMCPRequest() {
    console.log('\n⚡ Testing MCP Request via HTTP...');
    
    try {
      const mcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'read_file',
        params: {
          path: '/etc/hostname'
        }
      };
      
      const response = await fetch(`${this.serverUrl}/api/mcp/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.deviceToken}`
        },
        body: JSON.stringify({
          deviceToken: this.deviceToken,
          request: mcpRequest
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`MCP request failed: ${response.status} - ${error}`);
      }

      const result = await response.json();
      console.log('✅ MCP request completed');
      console.log(`   Result: ${JSON.stringify(result, null, 2)}`);
      
    } catch (error) {
      console.error('❌ MCP request test failed:', error.message);
    }
  }
}

// CLI Usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node test-sse.js <SERVER_URL> <DEVICE_TOKEN>');
    console.error('Example: node test-sse.js http://localhost:3002 eyJhbGciOiJIUzI1NiI...');
    process.exit(1);
  }

  const [serverUrl, deviceToken] = args;
  const test = new SSETest(serverUrl, deviceToken);

  test.runTest().then(() => {
    console.log('\n🎉 SSE test suite completed!');
  }).catch(error => {
    console.error('💥 Test suite failed:', error);
    process.exit(1);
  });
}