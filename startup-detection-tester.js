#!/usr/bin/env node

/**
 * Comprehensive Startup Detection Test Suite
 * 
 * This script runs various scenarios to test startup detection methods.
 * It provides practical examples of how to test different startup scenarios.
 */

import { execSync, spawn } from 'child_process';
import { platform } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class StartupDetectionTester {
  constructor() {
    this.testScript = join(__dirname, 'startup-detection-test.js');
    this.results = [];
  }

  /**
   * Run the detection script and capture results
   */
  async runDetectionScript(method, envOverrides = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...envOverrides };
      
      const child = spawn('node', [this.testScript], {
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
        resolve({
          method,
          stdout,
          stderr,
          exitCode: code,
          environment: envOverrides
        });
      });

      child.on('error', (error) => {
        reject(error);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        child.kill();
        reject(new Error(`Test for ${method} timed out`));
      }, 10000);
    });
  }

  /**
   * Test direct node execution
   */
  async testDirectNode() {
    console.log('🔍 Testing: Direct Node Execution');
    console.log('Command: node startup-detection-test.js');
    
    try {
      const result = await this.runDetectionScript('direct-node');
      this.results.push(result);
      console.log('✅ Direct node test completed\n');
      return result;
    } catch (error) {
      console.error('❌ Direct node test failed:', error.message);
      return null;
    }
  }

  /**
   * Test npm run simulation
   */
  async testNpmRun() {
    console.log('🔍 Testing: NPM Run Simulation');
    console.log('Simulating: npm run test');
    
    const npmEnv = {
      npm_lifecycle_event: 'test',
      npm_lifecycle_script: 'node startup-detection-test.js',
      npm_config_user_agent: 'npm/8.19.2 node/v18.12.1 darwin x64 workspaces/false',
      npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      npm_node_execpath: '/usr/local/bin/node',
      npm_package_name: '@wonderwhy-er/desktop-commander',
      npm_package_version: '0.2.3'
    };

    try {
      const result = await this.runDetectionScript('npm-run', npmEnv);
      this.results.push(result);
      console.log('✅ NPM run test completed\n');
      return result;
    } catch (error) {
      console.error('❌ NPM run test failed:', error.message);
      return null;
    }
  }

  /**
   * Test npx simulation
   */
  async testNpx() {
    console.log('🔍 Testing: NPX Simulation');
    console.log('Simulating: npx @wonderwhy-er/desktop-commander');
    
    const npxEnv = {
      npm_config_user_agent: 'npx/8.19.2 node/v18.12.1 darwin x64 workspaces/false',
      NPM_CLI_JS: '/usr/local/lib/node_modules/npm/bin/npx-cli.js',
      npm_execpath: '/usr/local/lib/node_modules/npm/bin/npx-cli.js'
    };

    try {
      const result = await this.runDetectionScript('npx', npxEnv);
      this.results.push(result);
      console.log('✅ NPX test completed\n');
      return result;
    } catch (error) {
      console.error('❌ NPX test failed:', error.message);
      return null;
    }
  }

  /**
   * Test Docker simulation
   */
  async testDocker() {
    console.log('🔍 Testing: Docker Simulation');
    console.log('Simulating: Docker container environment');
    
    const dockerEnv = {
      container: 'docker',
      HOSTNAME: 'a1b2c3d4e5f6', // Typical Docker hostname
      HOME: '/root',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    };

    try {
      const result = await this.runDetectionScript('docker', dockerEnv);
      this.results.push(result);
      console.log('✅ Docker test completed\n');
      return result;
    } catch (error) {
      console.error('❌ Docker test failed:', error.message);
      return null;
    }
  }

  /**
   * Test GitHub Actions simulation
   */
  async testGitHubActions() {
    console.log('🔍 Testing: GitHub Actions Simulation');
    console.log('Simulating: GitHub Actions CI environment');
    
    const githubEnv = {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKFLOW: 'test',
      GITHUB_RUN_ID: '123456789',
      GITHUB_ACTOR: 'wonderwhy-er',
      GITHUB_REPOSITORY: 'wonderwhy-er/DesktopCommanderMCP',
      RUNNER_OS: 'Linux'
    };

    try {
      const result = await this.runDetectionScript('github-actions', githubEnv);
      this.results.push(result);
      console.log('✅ GitHub Actions test completed\n');
      return result;
    } catch (error) {
      console.error('❌ GitHub Actions test failed:', error.message);
      return null;
    }
  }

  /**
   * Test with production environment
   */
  async testProduction() {
    console.log('🔍 Testing: Production Environment');
    console.log('Simulating: NODE_ENV=production');
    
    const prodEnv = {
      NODE_ENV: 'production'
    };

    try {
      const result = await this.runDetectionScript('production', prodEnv);
      this.results.push(result);
      console.log('✅ Production test completed\n');
      return result;
    } catch (error) {
      console.error('❌ Production test failed:', error.message);
      return null;
    }
  }

  /**
   * Run all tests
   */
  async runAllTests() {
    console.log('🧪 Starting Comprehensive Startup Detection Tests');
    console.log('================================================\n');

    const tests = [
      () => this.testDirectNode(),
      () => this.testNpmRun(),
      () => this.testNpx(),
      () => this.testDocker(),
      () => this.testGitHubActions(),
      () => this.testProduction()
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

    this.printSummary();
  }

  /**
   * Print test summary
   */
  printSummary() {
    console.log('📊 Test Summary');
    console.log('===============\n');

    for (const result of this.results) {
      console.log(`${result.method.toUpperCase()}:`);
      console.log(`  Exit Code: ${result.exitCode}`);
      console.log(`  Environment Variables: ${Object.keys(result.environment).length}`);
      
      // Extract the summary from stdout
      const summaryMatch = result.stdout.match(/Most likely startup method: (.+)/);
      if (summaryMatch) {
        console.log(`  Detected Method: ${summaryMatch[1]}`);
      }
      
      const confidenceMatch = result.stdout.match(/Confidence: (.+)/);
      if (confidenceMatch) {
        console.log(`  Confidence: ${confidenceMatch[1]}`);
      }
      
      console.log();
    }

    console.log('✅ All tests completed!');
    console.log('\n💡 Integration Tips:');
    console.log('- Use the production startup-detector.ts in your main server');
    console.log('- Log startup method for debugging and analytics');
    console.log('- Adjust behavior based on environment (dev vs prod vs CI)');
    console.log('- Monitor startup methods in production for insights');
  }

  /**
   * Create a simple integration example
   */
  createIntegrationExample() {
    const example = `
// Integration Example for your server.ts
import { getStartupInfo, getStartupMethod, isProduction, isDevelopment } from './utils/startup-detector.js';

// In your server startup code:
export async function startServer() {
  const startupInfo = getStartupInfo();
  
  console.log(\`🚀 Server starting via: \${getStartupMethod()}\`);
  console.log(\`📍 Environment: \${startupInfo.environment}\`);
  console.log(\`🔍 Confidence: \${startupInfo.confidence}%\`);
  
  // Conditional behavior based on startup method
  if (isProduction()) {
    // Production-specific setup
    console.log('Production mode: Enhanced logging enabled');
  } else if (isDevelopment()) {
    // Development-specific setup
    console.log('Development mode: Debug features enabled');
  }
  
  // Log startup method for analytics
  capture('server_startup', {
    method: startupInfo.method,
    environment: startupInfo.environment,
    confidence: startupInfo.confidence
  });
  
  // Your existing server startup code...
}
`;

    console.log('📝 Integration Example:');
    console.log(example);
  }
}

// Create a real-world testing scenario
async function demonstrateRealWorldUsage() {
  console.log('🌍 Real-World Usage Demonstration');
  console.log('==================================\n');

  // Test the production module directly
  try {
    const { getStartupInfo, getStartupMethod } = await import('./src/utils/startup-detector.js');
    
    const info = getStartupInfo();
    console.log('Current execution detected as:');
    console.log(`Method: ${getStartupMethod()}`);
    console.log(`Environment: ${info.environment}`);
    console.log(`Confidence: ${info.confidence}%`);
    console.log(`Evidence: ${info.details.evidence.join(', ')}\n`);
    
  } catch (error) {
    console.log('Production module not yet built. Run: npm run build\n');
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Startup Detection Test Suite

Usage:
  node startup-detection-tester.js [options]

Options:
  --all              Run all test scenarios
  --real-world       Test current execution method
  --integration      Show integration example
  --direct           Test direct node execution only
  --npm              Test npm run simulation only
  --npx              Test npx simulation only
  --docker           Test docker simulation only
  --ci               Test CI environment only
  --help, -h         Show this help message

Examples:
  node startup-detection-tester.js --all
  node startup-detection-tester.js --real-world
  npm run test-startup  # If you add this to package.json
`);
    return;
  }

  const tester = new StartupDetectionTester();

  if (args.includes('--real-world')) {
    await demonstrateRealWorldUsage();
  }

  if (args.includes('--integration')) {
    tester.createIntegrationExample();
  }

  if (args.includes('--all')) {
    await tester.runAllTests();
  } else {
    // Run individual tests based on flags
    if (args.includes('--direct')) await tester.testDirectNode();
    if (args.includes('--npm')) await tester.testNpmRun();
    if (args.includes('--npx')) await tester.testNpx();
    if (args.includes('--docker')) await tester.testDocker();
    if (args.includes('--ci')) await tester.testGitHubActions();
    
    // If no specific tests requested, run real-world demo
    if (!args.some(arg => arg.startsWith('--'))) {
      await demonstrateRealWorldUsage();
    }
  }
}

main().catch(console.error);
