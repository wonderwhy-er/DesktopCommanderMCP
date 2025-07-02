#!/usr/bin/env node

/**
 * Startup Detection Test Script
 * 
 * This script demonstrates various methods to detect how a Node.js application
 * is being started (npm, npx, docker, node, etc.)
 */

import { platform } from 'os';
import { readFileSync } from 'fs';
import { dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class StartupDetector {
  constructor() {
    this.detectionResults = {};
    this.environmentVars = this.captureRelevantEnvVars();
  }

  /**
   * Capture all relevant environment variables for analysis
   */
  captureRelevantEnvVars() {
    const relevantKeys = [
      // NPM related
      'npm_lifecycle_event',
      'npm_lifecycle_script',
      'npm_config_user_agent',
      'npm_node_execpath',
      'npm_execpath',
      'npm_package_name',
      'npm_package_version',
      'NPM_CLI_JS',
      
      // Docker related
      'DOCKER_CONTAINER',
      'DOCKER_HOST',
      'DOCKER_ENV',
      'container',
      'HOSTNAME',
      
      // Process related
      'INIT_CWD',
      'PWD',
      'OLDPWD',
      '_',
      'SHELL',
      
      // CI/CD related
      'CI',
      'GITHUB_ACTIONS',
      'JENKINS_URL',
      'DOCKER_BUILDKIT',
      
      // System related
      'USER',
      'HOME',
      'PATH'
    ];

    const envVars = {};
    for (const key of relevantKeys) {
      if (process.env[key]) {
        envVars[key] = process.env[key];
      }
    }
    
    // Also capture any env var that starts with npm_ or NPM_
    for (const key in process.env) {
      if (key.toLowerCase().startsWith('npm_') || key.startsWith('NPM_')) {
        envVars[key] = process.env[key];
      }
    }
    
    return envVars;
  }

  /**
   * Detect if running via npm run command
   */
  detectNpmRun() {
    const result = {
      detected: false,
      confidence: 0,
      evidence: []
    };

    // Primary indicator - npm_lifecycle_event is only set during npm run
    if (process.env.npm_lifecycle_event) {
      result.detected = true;
      result.confidence += 50;
      result.evidence.push(`npm_lifecycle_event: ${process.env.npm_lifecycle_event}`);
    }

    // Additional npm script indicators
    if (process.env.npm_lifecycle_script) {
      result.confidence += 20;
      result.evidence.push(`npm_lifecycle_script: ${process.env.npm_lifecycle_script}`);
    }

    // Check if npm is in the execution path
    if (process.env.npm_execpath) {
      result.confidence += 15;
      result.evidence.push(`npm_execpath: ${process.env.npm_execpath}`);
    }

    // Check user agent for npm
    if (process.env.npm_config_user_agent && 
        process.env.npm_config_user_agent.includes('npm') && 
        !process.env.npm_config_user_agent.includes('npx')) {
      result.confidence += 15;
      result.evidence.push(`npm_config_user_agent: ${process.env.npm_config_user_agent}`);
    }

    this.detectionResults.npmRun = result;
    return result;
  }

  /**
   * Detect if running via npx
   */
  detectNpx() {
    const result = {
      detected: false,
      confidence: 0,
      evidence: []
    };

    // Check user agent for npx
    if (process.env.npm_config_user_agent && 
        process.env.npm_config_user_agent.includes('npx')) {
      result.detected = true;
      result.confidence += 40;
      result.evidence.push(`npm_config_user_agent contains npx: ${process.env.npm_config_user_agent}`);
    }

    // NPX specific environment variables
    if (process.env.NPM_CLI_JS && process.env.NPM_CLI_JS.includes('npx')) {
      result.confidence += 30;
      result.evidence.push(`NPM_CLI_JS: ${process.env.NPM_CLI_JS}`);
    }

    // Check if we're in a temporary directory (npx often creates temp dirs)
    const cwd = process.cwd();
    if (cwd.includes('tmp') || cwd.includes('temp') || cwd.includes('_npx')) {
      result.confidence += 20;
      result.evidence.push(`Running in temp directory: ${cwd}`);
    }

    this.detectionResults.npx = result;
    return result;
  }

  /**
   * Detect if running in Docker
   */
  detectDocker() {
    const result = {
      detected: false,
      confidence: 0,
      evidence: []
    };

    // Check for common Docker indicators
    if (process.env.container === 'docker' || process.env.container === 'podman') {
      result.detected = true;
      result.confidence += 50;
      result.evidence.push(`container env var: ${process.env.container}`);
    }

    // Check for .dockerenv file (most reliable)
    try {
      readFileSync('/.dockerenv');
      result.detected = true;
      result.confidence += 70;
      result.evidence.push('/.dockerenv file exists');
    } catch (error) {
      // File doesn't exist, not in Docker
    }

    // Check for docker-related environment variables
    if (process.env.DOCKER_CONTAINER) {
      result.confidence += 40;
      result.evidence.push(`DOCKER_CONTAINER: ${process.env.DOCKER_CONTAINER}`);
    }

    // Check hostname patterns common in Docker
    if (process.env.HOSTNAME && process.env.HOSTNAME.length === 12 && 
        /^[a-f0-9]{12}$/.test(process.env.HOSTNAME)) {
      result.confidence += 30;
      result.evidence.push(`Docker-like hostname: ${process.env.HOSTNAME}`);
    }

    // Check for cgroup indicators
    try {
      const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
      if (cgroup.includes('docker') || cgroup.includes('containerd')) {
        result.detected = true;
        result.confidence += 60;
        result.evidence.push('Docker found in /proc/1/cgroup');
      }
    } catch (error) {
      // Likely not Linux or no access to /proc
    }

    this.detectionResults.docker = result;
    return result;
  }

  /**
   * Detect if running directly with node
   */
  async detectDirectNode() {
    const result = {
      detected: false,
      confidence: 0,
      evidence: []
    };

    // If no npm/npx indicators are present, likely direct node
    if (!process.env.npm_lifecycle_event && 
        !process.env.npm_config_user_agent &&
        !process.env.npm_execpath) {
      result.detected = true;
      result.confidence += 30;
      result.evidence.push('No npm-related environment variables found');
    }

    // Check if the parent process is node
    const parentCommand = await this.getParentProcessCommand();
    if (parentCommand && parentCommand.includes('node')) {
      result.confidence += 20;
      result.evidence.push(`Parent process: ${parentCommand}`);
    }

    // Check argv[0] for node
    if (process.argv[0] && basename(process.argv[0]).startsWith('node')) {
      result.confidence += 25;
      result.evidence.push(`process.argv[0]: ${process.argv[0]}`);
    }

    this.detectionResults.directNode = result;
    return result;
  }

  /**
   * Detect CI/CD environments
   */
  detectCiCd() {
    const result = {
      detected: false,
      confidence: 0,
      evidence: [],
      platform: null
    };

    const ciIndicators = {
      'GitHub Actions': process.env.GITHUB_ACTIONS,
      'Jenkins': process.env.JENKINS_URL,
      'GitLab CI': process.env.GITLAB_CI,
      'CircleCI': process.env.CIRCLECI,
      'Travis CI': process.env.TRAVIS,
      'Azure DevOps': process.env.TF_BUILD,
      'Bamboo': process.env.bamboo_buildKey,
      'TeamCity': process.env.TEAMCITY_VERSION
    };

    for (const [platform, indicator] of Object.entries(ciIndicators)) {
      if (indicator) {
        result.detected = true;
        result.platform = platform;
        result.confidence += 50;
        result.evidence.push(`${platform} detected`);
        break;
      }
    }

    // Generic CI indicator
    if (process.env.CI === 'true' || process.env.CI === '1') {
      result.detected = true;
      result.confidence += 30;
      result.evidence.push('Generic CI environment detected');
    }

    this.detectionResults.cicd = result;
    return result;
  }

  /**
   * Try to get parent process command (system dependent)
   */
  async getParentProcessCommand() {
    try {
      if (platform() === 'darwin' || platform() === 'linux') {
        // On Unix-like systems, try to get parent process info
        const { execSync } = await import('child_process');
        const ppid = process.ppid;
        if (ppid) {
          const result = execSync(`ps -p ${ppid} -o comm=`, { encoding: 'utf8', timeout: 1000 });
          return result.trim();
        }
      }
    } catch (error) {
      // Ignore errors, parent process detection is best-effort
    }
    return null;
  }

  /**
   * Analyze process arguments for clues
   */
  analyzeProcessArgs() {
    const analysis = {
      argv: [...process.argv],
      execPath: process.execPath,
      execArgv: [...process.execArgv],
      scriptName: basename(process.argv[1] || ''),
      insights: []
    };

    // Check for debugging flags
    if (process.execArgv.some(arg => arg.includes('inspect'))) {
      analysis.insights.push('Debug mode detected');
    }

    // Check for script name patterns
    if (analysis.scriptName.includes('setup')) {
      analysis.insights.push('Setup script detected');
    }

    return analysis;
  }

  /**
   * Run all detection methods and provide summary
   */
  async detectAll() {
    console.log('🔍 Node.js Startup Detection Analysis');
    console.log('=====================================\n');

    // Run all detections
    this.detectNpmRun();
    this.detectNpx();
    this.detectDocker();
    await this.detectDirectNode();
    this.detectCiCd();

    // Process arguments analysis
    const argsAnalysis = this.analyzeProcessArgs();

    // Print results
    this.printResults();
    this.printEnvironmentVars();
    this.printProcessAnalysis(argsAnalysis);
    this.printSummary();

    return {
      detectionResults: this.detectionResults,
      environmentVars: this.environmentVars,
      processAnalysis: argsAnalysis,
      summary: this.generateSummary()
    };
  }

  printResults() {
    console.log('Detection Results:');
    console.log('------------------');

    for (const [method, result] of Object.entries(this.detectionResults)) {
      const status = result.detected ? '✅ DETECTED' : '❌ Not detected';
      const confidence = result.confidence > 0 ? ` (${result.confidence}% confidence)` : '';
      
      console.log(`${method.toUpperCase()}: ${status}${confidence}`);
      
      if (result.evidence.length > 0) {
        result.evidence.forEach(evidence => {
          console.log(`  - ${evidence}`);
        });
      }
      console.log();
    }
  }

  printEnvironmentVars() {
    console.log('Relevant Environment Variables:');
    console.log('-------------------------------');
    
    if (Object.keys(this.environmentVars).length === 0) {
      console.log('No relevant environment variables found.\n');
      return;
    }

    for (const [key, value] of Object.entries(this.environmentVars)) {
      console.log(`${key}: ${value}`);
    }
    console.log();
  }

  printProcessAnalysis(analysis) {
    console.log('Process Analysis:');
    console.log('-----------------');
    console.log(`Script: ${analysis.scriptName}`);
    console.log(`Exec Path: ${analysis.execPath}`);
    console.log(`Process Args: ${analysis.argv.join(' ')}`);
    console.log(`Exec Args: ${analysis.execArgv.join(' ')}`);
    
    if (analysis.insights.length > 0) {
      console.log('Insights:');
      analysis.insights.forEach(insight => console.log(`  - ${insight}`));
    }
    console.log();
  }

  generateSummary() {
    const detected = Object.entries(this.detectionResults)
      .filter(([_, result]) => result.detected)
      .sort(([_, a], [__, b]) => b.confidence - a.confidence);

    if (detected.length === 0) {
      return {
        mostLikely: 'Direct Node.js execution',
        confidence: 'Low',
        alternatives: []
      };
    }

    const [mostLikelyMethod, mostLikelyResult] = detected[0];
    const alternatives = detected.slice(1).map(([method, result]) => ({
      method,
      confidence: result.confidence
    }));

    return {
      mostLikely: mostLikelyMethod,
      confidence: mostLikelyResult.confidence >= 70 ? 'High' : 
                 mostLikelyResult.confidence >= 40 ? 'Medium' : 'Low',
      alternatives
    };
  }

  printSummary() {
    const summary = this.generateSummary();
    
    console.log('Summary:');
    console.log('--------');
    console.log(`Most likely startup method: ${summary.mostLikely.toUpperCase()}`);
    console.log(`Confidence: ${summary.confidence}`);
    
    if (summary.alternatives.length > 0) {
      console.log('Alternative possibilities:');
      summary.alternatives.forEach(alt => {
        console.log(`  - ${alt.method} (${alt.confidence}% confidence)`);
      });
    }
    console.log();
  }
}

// Create and run the detector
const detector = new StartupDetector();
const results = await detector.detectAll();

// Export for potential use in other modules
export { StartupDetector };
export default results;
