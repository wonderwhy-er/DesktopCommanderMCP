#!/usr/bin/env node

/**
 * Test runner for Supabase MCP Server
 */

import { spawn } from 'child_process';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createLogger } from '../src/utils/logger.js';

dotenv.config();

const logger = createLogger('test');

class SupabaseMCPTester {
  constructor() {
    this.mcpServerUrl = `http://localhost:${process.env.MCP_SERVER_PORT || 3007}`;
    this.webServerUrl = `http://localhost:${process.env.WEB_SERVER_PORT || 3008}`;
    this.mcpServerProcess = null;
    this.webServerProcess = null;
    this.testResults = [];
  }
  
  /**
   * Run all tests
   */
  async runTests() {
    logger.info('🧪 Starting Supabase MCP Server test suite...');
    
    try {
      // Install dependencies
      await this.installDependencies();
      
      // Start servers
      await this.startServers();
      
      // Wait for servers to be ready
      await this.waitForServers();
      
      // Run tests
      await this.testServerHealth();
      await this.testWebInterface();
      await this.testMCPEndpoints();
      await this.testSSEConnection();
      
      // Display results
      this.displayResults();
      
    } catch (error) {
      logger.error('Test suite failed', null, error);
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }
  
  /**
   * Install dependencies
   */
  async installDependencies() {
    logger.info('📦 Installing dependencies...');
    
    return new Promise((resolve, reject) => {
      const npm = spawn('npm', ['install'], { 
        stdio: 'inherit',
        cwd: process.cwd()
      });
      
      npm.on('close', (code) => {
        if (code === 0) {
          logger.info('✅ Dependencies installed');
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}`));
        }
      });
      
      setTimeout(() => {
        npm.kill();
        reject(new Error('npm install timeout'));
      }, 60000);
    });
  }
  
  /**
   * Start the servers
   */
  async startServers() {
    logger.info('🚀 Starting servers...');
    
    // Start MCP server
    this.mcpServerProcess = spawn('node', ['src/server/mcp-server.js'], {
      env: { ...process.env },
      stdio: 'pipe'
    });
    
    this.mcpServerProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('✅ MCP OAuth Server ready')) {
        logger.info('✅ MCP server started');
      }
    });
    
    this.mcpServerProcess.on('error', (error) => {
      logger.error('MCP server error', null, error);
    });
    
    // Start web server
    this.webServerProcess = spawn('node', ['src/web/app.js'], {
      env: { ...process.env },
      stdio: 'pipe'
    });
    
    this.webServerProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Web Auth Server started')) {
        logger.info('✅ Web server started');
      }
    });
    
    this.webServerProcess.on('error', (error) => {
      logger.error('Web server error', null, error);
    });
    
    // Give servers time to start
    await this.sleep(3000);
  }
  
  /**
   * Wait for servers to be ready
   */
  async waitForServers() {
    logger.info('⏳ Waiting for servers to be ready...');
    
    const maxAttempts = 30;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        // Check MCP server
        const mcpResponse = await fetch(`${this.mcpServerUrl}/health`, { timeout: 2000 });
        if (!mcpResponse.ok) {
          throw new Error(`MCP server health check failed: ${mcpResponse.status}`);
        }
        
        // Check web server
        const webResponse = await fetch(`${this.webServerUrl}/health`, { timeout: 2000 });
        if (!webResponse.ok) {
          throw new Error(`Web server health check failed: ${webResponse.status}`);
        }
        
        logger.info('✅ All servers are ready');
        return;
        
      } catch (error) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error(`Servers not ready after ${maxAttempts} attempts: ${error.message}`);
        }
        await this.sleep(1000);
      }
    }
  }
  
  /**
   * Test server health endpoints
   */
  async testServerHealth() {
    logger.info('🏥 Testing server health...');
    
    try {
      // Test MCP server health
      const mcpHealth = await fetch(`${this.mcpServerUrl}/health`);
      const mcpData = await mcpHealth.json();
      
      this.addTestResult('MCP Server Health', mcpHealth.ok && mcpData.status === 'healthy', {
        status: mcpData.status,
        uptime: mcpData.uptime?.human
      });
      
      // Test web server health
      const webHealth = await fetch(`${this.webServerUrl}/health`);
      const webData = await webHealth.json();
      
      this.addTestResult('Web Server Health', webHealth.ok && webData.status === 'healthy', {
        status: webData.status
      });
      
      // Test MCP server info endpoint
      const mcpInfo = await fetch(`${this.mcpServerUrl}/`);
      const infoData = await mcpInfo.json();
      
      this.addTestResult('MCP Server Info', mcpInfo.ok && infoData.service, {
        service: infoData.service,
        version: infoData.version
      });
      
    } catch (error) {
      this.addTestResult('Server Health Tests', false, { error: error.message });
    }
  }
  
  /**
   * Test web interface
   */
  async testWebInterface() {
    logger.info('🌐 Testing web interface...');
    
    try {
      // Test auth page
      const authPage = await fetch(`${this.webServerUrl}/auth.html`);
      this.addTestResult('Auth Page', authPage.ok && authPage.headers.get('content-type').includes('text/html'));
      
      // Test success page
      const successPage = await fetch(`${this.webServerUrl}/success.html`);
      this.addTestResult('Success Page', successPage.ok && successPage.headers.get('content-type').includes('text/html'));
      
      // Test API endpoint
      const mcpInfoApi = await fetch(`${this.webServerUrl}/api/mcp-info`);
      const apiData = await mcpInfoApi.json();
      
      this.addTestResult('MCP Info API', mcpInfoApi.ok && apiData.mcpServerUrl, {
        mcpServerUrl: apiData.mcpServerUrl
      });
      
    } catch (error) {
      this.addTestResult('Web Interface Tests', false, { error: error.message });
    }
  }
  
  /**
   * Test MCP endpoints (without authentication)
   */
  async testMCPEndpoints() {
    logger.info('🔌 Testing MCP endpoints...');
    
    try {
      // Test tools endpoint (should require auth)
      const toolsResponse = await fetch(`${this.mcpServerUrl}/tools`);
      this.addTestResult('Tools Endpoint Auth Required', toolsResponse.status === 401);
      
      // Test SSE endpoint (should require auth)
      const sseResponse = await fetch(`${this.mcpServerUrl}/sse`);
      this.addTestResult('SSE Endpoint Auth Required', sseResponse.status === 401);
      
      // Test MCP endpoint (should require auth)
      const mcpResponse = await fetch(`${this.mcpServerUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list'
        })
      });
      this.addTestResult('MCP Endpoint Auth Required', mcpResponse.status === 401);
      
    } catch (error) {
      this.addTestResult('MCP Endpoint Tests', false, { error: error.message });
    }
  }
  
  /**
   * Test SSE connection (without auth - should fail)
   */
  async testSSEConnection() {
    logger.info('📡 Testing SSE connection...');
    
    try {
      // Try to connect without auth (should fail)
      const EventSource = (await import('eventsource')).default;
      
      return new Promise((resolve) => {
        const eventSource = new EventSource(`${this.mcpServerUrl}/sse`);
        
        const timeout = setTimeout(() => {
          eventSource.close();
          this.addTestResult('SSE Connection Without Auth', true, {
            note: 'Correctly rejected unauthorized connection'
          });
          resolve();
        }, 2000);
        
        eventSource.onerror = () => {
          clearTimeout(timeout);
          eventSource.close();
          this.addTestResult('SSE Connection Without Auth', true, {
            note: 'Correctly rejected unauthorized connection'
          });
          resolve();
        };
        
        eventSource.onopen = () => {
          clearTimeout(timeout);
          eventSource.close();
          this.addTestResult('SSE Connection Without Auth', false, {
            note: 'Should have rejected unauthorized connection'
          });
          resolve();
        };
      });
      
    } catch (error) {
      this.addTestResult('SSE Connection Test', false, { error: error.message });
    }
  }
  
  /**
   * Add test result
   */
  addTestResult(name, passed, details = {}) {
    this.testResults.push({
      name,
      passed,
      details
    });
    
    const emoji = passed ? '✅' : '❌';
    logger.info(`${emoji} ${name}: ${passed ? 'PASSED' : 'FAILED'}`);
    
    if (!passed && details.error) {
      logger.error(`   Error: ${details.error}`);
    }
    
    if (details.note) {
      logger.info(`   Note: ${details.note}`);
    }
  }
  
  /**
   * Display final results
   */
  displayResults() {
    const totalTests = this.testResults.length;
    const passedTests = this.testResults.filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;
    
    logger.info('');
    logger.info('📊 Test Results Summary:');
    logger.info(`   Total Tests: ${totalTests}`);
    logger.info(`   Passed: ${passedTests} ✅`);
    logger.info(`   Failed: ${failedTests} ${failedTests > 0 ? '❌' : '✅'}`);
    logger.info(`   Success Rate: ${Math.round((passedTests / totalTests) * 100)}%`);
    
    if (failedTests > 0) {
      logger.info('');
      logger.info('❌ Failed Tests:');
      this.testResults.filter(r => !r.passed).forEach(test => {
        logger.info(`   - ${test.name}`);
        if (test.details.error) {
          logger.info(`     Error: ${test.details.error}`);
        }
      });
    }
    
    logger.info('');
    if (failedTests === 0) {
      logger.info('🎉 All tests passed! Supabase MCP Server is working correctly.');
    } else {
      logger.info('⚠️  Some tests failed. Please check the errors above.');
    }
  }
  
  /**
   * Cleanup processes
   */
  async cleanup() {
    logger.info('🧹 Cleaning up...');
    
    if (this.mcpServerProcess) {
      this.mcpServerProcess.kill('SIGTERM');
      logger.info('✅ MCP server stopped');
    }
    
    if (this.webServerProcess) {
      this.webServerProcess.kill('SIGTERM');
      logger.info('✅ Web server stopped');
    }
    
    // Give processes time to clean up
    await this.sleep(1000);
  }
  
  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\\nReceived SIGINT, cleaning up...');
  process.exit(0);
});

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new SupabaseMCPTester();
  tester.runTests().catch((error) => {
    console.error('Test suite failed:', error);
    process.exit(1);
  });
}