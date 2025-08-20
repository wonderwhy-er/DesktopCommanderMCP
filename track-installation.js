#!/usr/bin/env node

/**
 * Installation Source Tracking Script
 * Runs during npm install to detect how Desktop Commander was installed
 * 
 * Debug logging can be enabled with:
 * - DEBUG=desktop-commander npm install
 * - DEBUG=* npm install  
 * - NODE_ENV=development npm install
 * - DC_DEBUG=true npm install
 */

import { randomUUID } from 'crypto';
import * as https from 'https';
import { platform } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current file directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Debug logging utility - configurable via environment variables
const DEBUG_ENABLED = process.env.DEBUG === 'desktop-commander' || 
                      process.env.DEBUG === '*' || 
                      process.env.NODE_ENV === 'development' ||
                      process.env.DC_DEBUG === 'true';

const debug = (...args) => {
    if (DEBUG_ENABLED) {
        console.log('[Desktop Commander Debug]', ...args);
    }
};

const log = (...args) => {
    // Always show important messages, but prefix differently for debug vs production
    if (DEBUG_ENABLED) {
        console.log('[Desktop Commander]', ...args);
    }
};

/**
 * Get the client ID from the Desktop Commander config file, or generate a new one
 */
async function getClientId() {
    try {
        const { homedir } = await import('os');
        const { join } = await import('path');
        const fs = await import('fs');
        
        const USER_HOME = homedir();
        const CONFIG_DIR = join(USER_HOME, '.claude-server-commander');
        const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
        
        // Try to read existing config
        if (fs.existsSync(CONFIG_FILE)) {
            const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
            const config = JSON.parse(configData);
            if (config.clientId) {
                debug(`Using existing clientId from config: ${config.clientId.substring(0, 8)}...`);
                return config.clientId;
            }
        }
        
        debug('No existing clientId found, generating new one');
        // Fallback to random UUID if config doesn't exist or lacks clientId
        return randomUUID();
    } catch (error) {
        debug(`Error reading config file: ${error.message}, using random UUID`);
        // If anything goes wrong, fall back to random UUID
        return randomUUID();
    }
}

// Google Analytics configuration (same as setup script)
const GA_MEASUREMENT_ID = 'G-NGGDNL0K4L';
const GA_API_SECRET = '5M0mC--2S_6t94m8WrI60A';
const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

/**
 * Detect installation source from environment and process context
 */
async function detectInstallationSource() {
    // Check npm environment variables for clues
    const npmConfigUserAgent = process.env.npm_config_user_agent || '';
    const npmExecpath = process.env.npm_execpath || '';
    const npmCommand = process.env.npm_command || '';
    const npmLifecycleEvent = process.env.npm_lifecycle_event || '';
    
    // Check process arguments and parent commands
    const processArgs = process.argv.join(' ');
    const processTitle = process.title || '';

    debug('Installation source detection...');
    debug(`npm_config_user_agent: ${npmConfigUserAgent}`);
    debug(`npm_execpath: ${npmExecpath}`);
    debug(`npm_command: ${npmCommand}`);
    debug(`npm_lifecycle_event: ${npmLifecycleEvent}`);
    debug(`process.argv: ${processArgs}`);
    debug(`process.title: ${processTitle}`);
    
    // Try to get parent process information
    let parentProcessInfo = null;
    try {
        const { execSync } = await import('child_process');
        const ppid = process.ppid;
        if (ppid && process.platform !== 'win32') {
            // Get parent process command line on Unix systems
            const parentCmd = execSync(`ps -p ${ppid} -o command=`, { encoding: 'utf8' }).trim();
            parentProcessInfo = parentCmd;
            debug(`parent process: ${parentCmd}`);
        }
    } catch (error) {
        debug(`Could not get parent process info: ${error.message}`);
    }
    
    // Smithery detection - look for smithery in the process chain
    const smitheryIndicators = [
        npmConfigUserAgent.includes('smithery'),
        npmExecpath.includes('smithery'),
        processArgs.includes('smithery'),
        processArgs.includes('@smithery/cli'),
        processTitle.includes('smithery'),
        parentProcessInfo && parentProcessInfo.includes('smithery'),
        parentProcessInfo && parentProcessInfo.includes('@smithery/cli')
    ];
    
    if (smitheryIndicators.some(indicator => indicator)) {
        return {
            source: 'smithery',
            details: {
                detection_method: 'process_chain',
                user_agent: npmConfigUserAgent,
                exec_path: npmExecpath,
                command: npmCommand,
                parent_process: parentProcessInfo || 'unknown',
                process_args: processArgs
            }
        };
    }
    
    // Direct NPX usage
    if (npmCommand === 'exec' || processArgs.includes('npx')) {
        return {
            source: 'npx-direct',
            details: {
                user_agent: npmConfigUserAgent,
                command: npmCommand,
                lifecycle_event: npmLifecycleEvent
            }
        };
    }
    
    // Regular npm install
    if (npmCommand === 'install' || npmLifecycleEvent === 'postinstall') {
        return {
            source: 'npm-install',
            details: {
                user_agent: npmConfigUserAgent,
                command: npmCommand,
                lifecycle_event: npmLifecycleEvent
            }
        };
    }
    
    // GitHub Codespaces
    if (process.env.CODESPACES) {
        return {
            source: 'github-codespaces',
            details: {
                codespace: process.env.CODESPACE_NAME || 'unknown'
            }
        };
    }
    
    // VS Code
    if (process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode') {
        return {
            source: 'vscode',
            details: {
                term_program: process.env.TERM_PROGRAM,
                vscode_pid: process.env.VSCODE_PID
            }
        };
    }
    
    // GitPod
    if (process.env.GITPOD_WORKSPACE_ID) {
        return {
            source: 'gitpod',
            details: {
                workspace_id: process.env.GITPOD_WORKSPACE_ID.substring(0, 8) + '...' // Truncate for privacy
            }
        };
    }
    
    // CI/CD environments
    if (process.env.CI) {
        if (process.env.GITHUB_ACTIONS) {
            return {
                source: 'github-actions',
                details: {
                    repository: process.env.GITHUB_REPOSITORY,
                    workflow: process.env.GITHUB_WORKFLOW
                }
            };
        }
        if (process.env.GITLAB_CI) {
            return {
                source: 'gitlab-ci',
                details: {
                    project: process.env.CI_PROJECT_NAME
                }
            };
        }
        if (process.env.JENKINS_URL) {
            return {
                source: 'jenkins',
                details: {
                    job: process.env.JOB_NAME
                }
            };
        }
        return {
            source: 'ci-cd-other',
            details: {
                ci_env: 'unknown'
            }
        };
    }
    
    // Docker detection
    if (process.env.DOCKER_CONTAINER) {
        return {
            source: 'docker',
            details: {
                container_id: process.env.HOSTNAME?.substring(0, 8) + '...' || 'unknown'
            }
        };
    }
    
    // Check for .dockerenv file (need to use fs import)
    try {
        const fs = await import('fs');
        if (fs.existsSync('/.dockerenv')) {
            return {
                source: 'docker',
                details: {
                    container_id: process.env.HOSTNAME?.substring(0, 8) + '...' || 'unknown'
                }
            };
        }
    } catch (error) {
        // Ignore fs errors
    }
    
    // Default fallback
    return {
        source: 'unknown',
        details: {
            user_agent: npmConfigUserAgent || 'none',
            command: npmCommand || 'none',
            lifecycle: npmLifecycleEvent || 'none'
        }
    };
}

/**
 * Send installation tracking to analytics
 */
async function trackInstallation(installationData) {
    if (!GA_MEASUREMENT_ID || !GA_API_SECRET) {
        debug('Analytics not configured, skipping tracking');
        return;
    }

    try {
        const uniqueUserId = await getClientId();
        log("user id", uniqueUserId)
        // Prepare GA4 payload
        const payload = {
            client_id: uniqueUserId,
            non_personalized_ads: false,
            timestamp_micros: Date.now() * 1000,
            events: [{
                name: 'package_installed',
                params: {
                    timestamp: new Date().toISOString(),
                    platform: platform(),
                    installation_source: installationData.source,
                    installation_details: JSON.stringify(installationData.details),
                    package_name: '@wonderwhy-er/desktop-commander',
                    install_method: 'npm-lifecycle',
                    node_version: process.version,
                    npm_version: process.env.npm_version || 'unknown'
                }
            }]
        };

        const postData = JSON.stringify(payload);
        
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        await new Promise((resolve, reject) => {
            const req = https.request(GA_BASE_URL, options);
            
            const timeoutId = setTimeout(() => {
                req.destroy();
                reject(new Error('Request timeout'));
            }, 5000);

            req.on('error', (error) => {
                clearTimeout(timeoutId);
                debug(`Analytics error: ${error.message}`);
                resolve(); // Don't fail installation on analytics error
            });

            req.on('response', (res) => {
                clearTimeout(timeoutId);
                // Consume the response data to complete the request
                res.on('data', () => {}); // Ignore response data
                res.on('end', () => {
                    log(`Installation tracked: ${installationData.source}`);
                    resolve();
                });
            });

            req.write(postData);
            req.end();
        });

    } catch (error) {
        debug(`Failed to track installation: ${error.message}`);
        // Don't fail the installation process
    }
}

/**
 * Main execution
 */
async function main() {
    try {
        log('Package installation detected');
        
        const installationData = await detectInstallationSource();
        log(`Installation source: ${installationData.source}`);
        
        await trackInstallation(installationData);
        
    } catch (error) {
        debug(`Installation tracking error: ${error.message}`);
        // Don't fail the installation
    }
}

// Only run if this script is executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { detectInstallationSource, trackInstallation };
