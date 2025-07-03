/**
 * Test script for HTTP transport functionality
 *
 * This script tests how the HTTP transport works:
 * 1. Testing HTTP server startup and connectivity
 * 2. Testing MCP protocol implementation over HTTP
 * 3. Testing error handling for invalid requests
 */

import { runHttpServer } from '../dist/http-transport.js';
import { configManager } from '../dist/config-manager.js';
import assert from 'assert';
import net from 'net';

/**
 * Helper function to find an available port
 */
async function findAvailablePort() {
  // Use Node.js net module to let the OS assign an available port

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    // Listen on port 0 to let the OS assign an available port
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });

    server.on('error', reject);
  });
}

/**
 * Helper function to parse Server-Sent Events format
 */
function parseSSE(sseText) {
  const lines = sseText.trim().split('\n');
  let data = '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      data = line.substring(6);
    }
  }

  if (data) {
    return JSON.parse(data);
  } else {
    throw new Error(`No data found in SSE response: ${sseText}`);
  }
}

/**
 * Helper function to make HTTP request
 */
async function makeHttpRequest(port, data) {
  const response = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(data),
  });

  // Verify expected response content type and parse result.
  assert.strictEqual(
    response.headers.get('content-type'),
    'text/event-stream',
    'Expected text/event-stream content type.'
  );
  const responseData = parseSSE(await response.text());

  return {
    status: response.status,
    data: responseData
  };
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig, httpServer) {
  // Close HTTP server if it exists
  if (httpServer) {
    try {
      httpServer.close();
    } catch (error) {
      // Ignore errors when closing server
    }
  }

  // Reset configuration to original
  if (originalConfig) {
    await configManager.updateConfig(originalConfig);
  }
}

/**
 * Test HTTP server startup and basic MCP communication
 */
async function testHttpServerStartup() {
  console.log('\nTest 1: HTTP server startup and MCP initialize');

  // Find an available port
  const port = await findAvailablePort();
  console.log(`Using port ${port} for HTTP transport test`);

  // Start HTTP server in background
  const serverPromise = runHttpServer(port);

  // Give server time to start
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Test MCP initialize request
  console.log('Testing MCP initialize request...');
  const initializeRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };

  const initResponse = await makeHttpRequest(port, initializeRequest);

  // Verify response
  assert.strictEqual(initResponse.status, 200, 'Initialize request should return 200 status');
  assert.ok(initResponse.data.result, 'Initialize response should have result');
  assert.ok(initResponse.data.result.capabilities, 'Initialize response should have capabilities');

  console.log('✓ HTTP server startup and MCP initialize test passed');
  return { port, serverPromise };
}

/**
 * Test MCP tools listing functionality
 */
async function testToolsListing(port) {
  console.log('\nTest 2: MCP tools listing');

  const listToolsRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  };

  const toolsResponse = await makeHttpRequest(port, listToolsRequest);

  // Verify response
  assert.strictEqual(toolsResponse.status, 200, 'Tools list request should return 200 status');
  assert.ok(toolsResponse.data.result, 'Tools list response should have result');
  assert.ok(Array.isArray(toolsResponse.data.result.tools), 'Tools list should be an array');
  assert.ok(toolsResponse.data.result.tools.length > 0, 'Should have at least one tool available');

  console.log(`✓ Tools list test passed (found ${toolsResponse.data.result.tools.length} tools)`);
}

/**
 * Test error handling for invalid requests
 */
async function testInvalidRequestHandling(port) {
  console.log('\nTest 3: Invalid request handling');

  const invalidRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'nonexistent/method',
    params: {}
  };

  const invalidResponse = await makeHttpRequest(port, invalidRequest);

  // Verify error response
  assert.strictEqual(invalidResponse.status, 200, 'Invalid request should still return 200 (error in body)');
  assert.ok(invalidResponse.data.error, 'Invalid request should return error in response body');

  console.log('✓ Invalid request handling test passed');
}

/**
 * Main test function for HTTP transport
 */
async function runHttpTransportTests() {
  console.log('=== HTTP Transport Tests ===');

  let serverInfo;

  try {
    // Test 1: HTTP server startup and MCP initialize
    serverInfo = await testHttpServerStartup();

    // Test 2: MCP tools listing
    await testToolsListing(serverInfo.port);

    // Test 3: Invalid request handling
    await testInvalidRequestHandling(serverInfo.port);

    console.log('\n✅ All HTTP transport tests passed!');
    return { success: true, serverInfo };

  } catch (error) {
    console.error('❌ HTTP transport test failed:', error.message);
    return { success: false, serverInfo };
  }
}

/**
 * Export the main test function
 */
export default async function runTests() {
  let originalConfig;
  let testResult;

  try {
    originalConfig = await configManager.getConfig();
    testResult = await runHttpTransportTests();
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  } finally {
    // Clean up server and config
    if (testResult && testResult.serverInfo) {
      await teardown(originalConfig, testResult.serverInfo.serverPromise);
    } else if (originalConfig) {
      await teardown(originalConfig);
    }
  }

  return testResult ? testResult.success : false;
}

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
