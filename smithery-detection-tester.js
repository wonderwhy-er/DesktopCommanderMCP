#!/usr/bin/env node

/**
 * Smithery Detection Test Script
 * 
 * Tests detection of Smithery CLI proxying by simulating various Smithery environments
 */

import { platform } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class SmitheryDetectionTester {
  constructor() {
    this.testResults = [];
  }

  /**
   * Run detection with specific environment variables
   */
  async runDetectionTest(testName, envOverrides = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...envOverrides };
      
      // Create a simple test script that imports our detector
      const testScript = `
        import('./dist/utils/smithery-detector.js').then(({ getSmitheryInfo, isSmithery }) => {
          const info = getSmitheryInfo();
          console.log(JSON.stringify({
            testName: '${testName}',
            isSmithery: isSmithery(),
            confidence: info.confidence,
            evidence: info.evidence,
            details: info.details
          }, null, 2));
        }).catch(error => {
          console.error('Error:', error.message);
          process.exit(1);
        });
      `;

      const child = spawn('node', ['-e', testScript], {
        env,
        stdio: 'pipe'
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        try {
          const result = JSON.parse(stdout);
          resolve({ ...result, stderr, exitCode: code });
        } catch (error) {
          resolve({
            testName,
            error: 'Failed to parse output',
            stdout,
            stderr,
            exitCode: code
          });
        }
      });

      child.on('error', (error) => {
        reject(error);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        child.kill();
        reject(new Error(`Test ${testName} timed out`));
      }, 10000);
    });
  }

  /**
   * Test baseline (no Smithery)
   */
  async testBaseline() {
    console.log('🧪 Testing: Baseline (No Smithery)');
    console.log('Description: Clean environment with no Smithery indicators');
    
    try {
      const result = await this.runDetectionTest('baseline');
      this.testResults.push(result);
      console.log(`✅ Result: ${result.isSmithery ? 'Smithery detected' : 'No Smithery detected'} (${result.confidence}% confidence)`);
      console.log();
      return result;
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      return null;
    }
  }

  /**
   * Test Smithery CLI environment simulation
   */
  async testSmitheryCliEnvironment() {
    console.log('🔍 Testing: Smithery CLI Environment');
    console.log('Description: Simulating environment variables set by Smithery CLI');
    
    const smitheryEnv = {
      SMITHERY_SESSION_ID: '01932d4b-8f5e-7890-abcd-123456789abc', // UUID v7 format
      SMITHERY_CLIENT: 'claude',
      SMITHERY_PROFILE: 'default',
      SMITHERY_ANALYTICS: 'true',
      SMITHERY_CONNECTION_TYPE: 'stdio',
      SMITHERY_QUALIFIED_NAME: '@wonderwhy-er/desktop-commander',
      REGISTRY_ENDPOINT: 'https://api.smithery.ai/registry',
      ANALYTICS_ENDPOINT: 'https://api.smithery.ai/analytics'
    };

    try {
      const result = await this.runDetectionTest('smithery-cli-env', smitheryEnv);
      this.testResults.push(result);
      console.log(\`✅ Result: \${result.isSmithery ? 'Smithery detected' : 'No Smithery detected'} (\${result.confidence}% confidence)\`);
      console.log(\`📋 Evidence: \${result.evidence?.slice(0, 3).join(', ')}...\`);
      console.log();
      return result;
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      return null;
    }
  }

  /**
   * Test Smithery NPX execution
   */
  async testSmitheryNpxExecution() {
    console.log('📦 Testing: Smithery NPX Execution');
    console.log('Description: Simulating npx @smithery/cli run command');
    
    const npxEnv = {
      npm_config_user_agent: 'npm/8.19.2 node/v18.12.1 darwin x64 workspaces/false',
      npm_execpath: '/usr/local/lib/node_modules/npm/bin/npx-cli.js',
      SMITHERY_SESSION_ID: '01932d4b-8f5e-7890-abcd-987654321def',
      SMITHERY_CLIENT: 'claude',
      MCP_TRANSPORT_TYPE: 'stdio'
    };

    // Also modify process.argv to simulate npx smithery command
    const originalArgv = process.argv[1];
    process.argv[1] = '/usr/local/lib/node_modules/@smithery/cli/dist/index.js';

    try {
      const result = await this.runDetectionTest('smithery-npx', npxEnv);
      this.testResults.push(result);
      console.log(\`✅ Result: \${result.isSmithery ? 'Smithery detected' : 'No Smithery detected'} (\${result.confidence}% confidence)\`);
      console.log(\`📋 Evidence: \${result.evidence?.slice(0, 3).join(', ')}...\`);
      console.log();
      return result;
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      return null;
    } finally {
      process.argv[1] = originalArgv;
    }
  }

  /**
   * Test Smithery HTTP/Remote connection
   */
  async testSmitheryRemoteConnection() {
    console.log('🌐 Testing: Smithery Remote Connection');
    console.log('Description: Simulating remote MCP server through Smithery');
    
    const remoteEnv = {
      SMITHERY_SESSION_ID: '01932d4b-8f5e-7890-abcd-fedcba987654',
      SMITHERY_CLIENT: 'cursor',
      SMITHERY_CONNECTION_TYPE: 'http',
      SMITHERY_QUALIFIED_NAME: 'remote-mcp-server',
      SMITHERY_ANALYTICS: 'true',
      REGISTRY_ENDPOINT: 'https://api.smithery.ai/registry',
      ANALYTICS_ENDPOINT: 'https://api.smithery.ai/analytics',
      MCP_SERVER_NAME: 'remote-server'
    };

    try {
      const result = await this.runDetectionTest('smithery-remote', remoteEnv);
      this.testResults.push(result);
      console.log(\`✅ Result: \${result.isSmithery ? 'Smithery detected' : 'No Smithery detected'} (\${result.confidence}% confidence)\`);
      console.log(\`📋 Evidence: \${result.evidence?.slice(0, 3).join(', ')}...\`);
      console.log();
      return result;
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      return null;
    }
  }

  /**
   * Test partial Smithery indicators
   */
  async testPartialSmitheryIndicators() {
    console.log('⚡ Testing: Partial Smithery Indicators');
    console.log('Description: Some but not all Smithery indicators present');
    
    const partialEnv = {
      REGISTRY_ENDPOINT: 'https://api.smithery.ai/registry',
      npm_config_user_agent: 'npm/8.19.2 node/v18.12.1 darwin x64 workspaces/false',
      MCP_TRANSPORT_TYPE: 'stdio'
    };

    try {
      const result = await this.runDetectionTest('smithery-partial', partialEnv);
      this.testResults.push(result);
      console.log(\`✅ Result: \${result.isSmithery ? 'Smithery detected' : 'No Smithery detected'} (\${result.confidence}% confidence)\`);
      console.log(\`📋 Evidence: \${result.evidence?.join(', ') || 'None'}\`);
      console.log();
      return result;
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      return null;
    }
  }

  /**
   * Test false positive resistance
   */
  async testFalsePositiveResistance() {
    console.log('🛡️  Testing: False Positive Resistance');
    console.log('Description: Similar but non-Smithery environment');
    
    const falsePositiveEnv = {
      npm_config_user_agent: 'npm/8.19.2 node/v18.12.1 darwin x64 workspaces/false',
      npm_lifecycle_event: 'start',
      MCP_SOME_OTHER_VAR: 'value',
      REGISTRY_ENDPOINT: 'https://some-other-registry.com'
    };

    try {
      const result = await this.runDetectionTest('false-positive-test', falsePositiveEnv);
      this.testResults.push(result);
      console.log(\`✅ Result: \${result.isSmithery ? 'Smithery detected' : 'No Smithery detected'} (\${result.confidence}% confidence)\`);
      console.log(\`📋 Evidence: \${result.evidence?.join(', ') || 'None'}\`);
      console.log();
      return result;
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      return null;
    }
  }

  /**
   * Run all tests
   */
  async runAllTests() {
    console.log('🧪 Smithery Detection Test Suite');
    console.log('=================================\\n');

    console.log('🏗️  Building project first...');
    try {
      const { execSync } = await import('child_process');
      execSync('npm run build', { cwd: process.cwd(), stdio: 'pipe' });
      console.log('✅ Build completed\\n');
    } catch (error) {
      console.error('❌ Build failed. Please run: npm run build');
      console.error(error.message);
      return;
    }

    const tests = [
      () => this.testBaseline(),
      () => this.testSmitheryCliEnvironment(),
      () => this.testSmitheryNpxExecution(),
      () => this.testSmitheryRemoteConnection(),
      () => this.testPartialSmitheryIndicators(),
      () => this.testFalsePositiveResistance()
    ];

    for (const test of tests) {
      try {
        await test();
        // Small delay between tests
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error('Test failed:', error);
      }
    }

    this.printTestSummary();
  }

  /**
   * Print comprehensive test summary
   */
  printTestSummary() {
    console.log('\\n📊 Test Summary');
    console.log('================');

    const summary = {
      total: this.testResults.length,
      detected: 0,
      notDetected: 0,
      errors: 0,
      averageConfidence: 0
    };

    console.log('\\nDetailed Results:');
    console.log('-----------------');

    for (const result of this.testResults) {
      if (result.error) {
        summary.errors++;
        console.log(\`❌ \${result.testName}: ERROR - \${result.error}\`);
        continue;
      }

      if (result.isSmithery) {
        summary.detected++;
        console.log(\`✅ \${result.testName}: DETECTED (\${result.confidence}% confidence)\`);
      } else {
        summary.notDetected++;
        console.log(\`⭕ \${result.testName}: NOT DETECTED (\${result.confidence}% confidence)\`);
      }

      summary.averageConfidence += result.confidence || 0;

      // Show top evidence
      if (result.evidence && result.evidence.length > 0) {
        console.log(\`   📝 Evidence: \${result.evidence.slice(0, 2).join(', ')}\${result.evidence.length > 2 ? '...' : ''}\`);
      }

      // Show key details
      if (result.details) {
        const keyDetails = [];
        if (result.details.clientType) keyDetails.push(\`Client: \${result.details.clientType}\`);
        if (result.details.connectionType) keyDetails.push(\`Connection: \${result.details.connectionType}\`);
        if (result.details.sessionId) keyDetails.push('Session ID: present');
        
        if (keyDetails.length > 0) {
          console.log(\`   🔍 Details: \${keyDetails.join(', ')}\`);
        }
      }
      
      console.log();
    }

    summary.averageConfidence = summary.averageConfidence / summary.total;

    console.log('\\n📈 Summary Statistics:');
    console.log(\`Total Tests: \${summary.total}\`);
    console.log(\`Smithery Detected: \${summary.detected}\`);
    console.log(\`Smithery Not Detected: \${summary.notDetected}\`);
    console.log(\`Errors: \${summary.errors}\`);
    console.log(\`Average Confidence: \${summary.averageConfidence.toFixed(1)}%\`);

    console.log('\\n💡 Integration Tips:');
    console.log('====================');
    console.log('• Use isSmithery() to check if running through Smithery');
    console.log('• Access getSmitheryClientType() to know which AI client is being used');
    console.log('• Check getSmitheryConnectionType() for connection type (stdio/http)');
    console.log('• Use getSmitherySessionId() for analytics correlation');
    console.log('• Monitor isSmitheryAnalyticsEnabled() for privacy compliance');

    console.log('\\n🚀 Expected Results:');
    console.log('• Baseline: Should NOT detect Smithery');
    console.log('• Smithery CLI Environment: Should DETECT with high confidence');
    console.log('• Smithery NPX: Should DETECT with medium-high confidence');
    console.log('• Smithery Remote: Should DETECT with high confidence');
    console.log('• Partial Indicators: May or may not detect (depends on confidence threshold)');
    console.log('• False Positive Test: Should NOT detect Smithery');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(\`
Smithery Detection Test Suite

Usage:
  node smithery-detection-tester.js [options]

Options:
  --all              Run all test scenarios (default)
  --baseline         Test baseline (no Smithery)
  --cli              Test Smithery CLI environment
  --npx              Test NPX execution
  --remote           Test remote connection
  --partial          Test partial indicators
  --false-positive   Test false positive resistance
  --help, -h         Show this help message

Examples:
  node smithery-detection-tester.js --all
  node smithery-detection-tester.js --cli
  npm run test:smithery  # If you add this to package.json
\`);
    return;
  }

  const tester = new SmitheryDetectionTester();

  if (args.includes('--all') || args.length === 0) {
    await tester.runAllTests();
  } else {
    // Run individual tests based on flags
    if (args.includes('--baseline')) await tester.testBaseline();
    if (args.includes('--cli')) await tester.testSmitheryCliEnvironment();
    if (args.includes('--npx')) await tester.testSmitheryNpxExecution();
    if (args.includes('--remote')) await tester.testSmitheryRemoteConnection();
    if (args.includes('--partial')) await tester.testPartialSmitheryIndicators();
    if (args.includes('--false-positive')) await tester.testFalsePositiveResistance();
    
    tester.printTestSummary();
  }
}

main().catch(console.error);
