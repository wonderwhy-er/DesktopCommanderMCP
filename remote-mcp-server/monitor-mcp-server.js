#!/usr/bin/env node

/**
 * Monitor script for MCP OAuth Server debugging
 * This script monitors server logs and provides real-time debugging information
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function colorLog(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function monitorProcess(child) {
  colorLog('cyan', `📊 Monitoring MCP server process (PID: ${child.pid})`);
  
  // Monitor process status
  const statusInterval = setInterval(() => {
    if (child.killed) {
      colorLog('red', '💀 Process has been killed');
      clearInterval(statusInterval);
      return;
    }
    
    const memUsage = process.memoryUsage();
    colorLog('blue', `📈 Monitor status - PID: ${child.pid}, Uptime: ${Math.floor(process.uptime())}s, Memory: ${Math.floor(memUsage.rss / 1024 / 1024)}MB`);
  }, 10000);

  // Monitor system signals
  process.on('SIGTERM', () => {
    colorLog('yellow', '⚠️  Monitor received SIGTERM');
    child.kill('SIGTERM');
  });

  process.on('SIGINT', () => {
    colorLog('yellow', '⚠️  Monitor received SIGINT');
    child.kill('SIGINT');
    process.exit(0);
  });

  return statusInterval;
}

function monitorLogs(logsDir) {
  colorLog('green', `📝 Monitoring logs directory: ${logsDir}`);
  
  if (!fs.existsSync(logsDir)) {
    colorLog('yellow', '📁 Creating logs directory...');
    fs.mkdirSync(logsDir);
  }

  fs.watch(logsDir, (eventType, filename) => {
    if (eventType === 'rename' && filename && filename.endsWith('.log')) {
      colorLog('green', `📄 New log file created: ${filename}`);
      
      // Watch the new log file for changes
      const logPath = path.join(logsDir, filename);
      let lastPosition = 0;
      
      const watchLog = () => {
        try {
          const stats = fs.statSync(logPath);
          if (stats.size > lastPosition) {
            const stream = fs.createReadStream(logPath, {
              start: lastPosition,
              encoding: 'utf8'
            });
            
            stream.on('data', (data) => {
              const lines = data.split('\n').filter(line => line.trim());
              lines.forEach(line => {
                try {
                  const logEntry = JSON.parse(line);
                  const levelColor = {
                    'ERROR': 'red',
                    'WARN': 'yellow', 
                    'INFO': 'green',
                    'DEBUG': 'blue'
                  }[logEntry.level] || 'reset';
                  
                  colorLog(levelColor, `[${logEntry.timestamp}] ${logEntry.level}: ${logEntry.message}`);
                  if (logEntry.data) {
                    colorLog('cyan', `  Data: ${JSON.stringify(logEntry.data, null, 2)}`);
                  }
                } catch (e) {
                  // Non-JSON log line
                  colorLog('magenta', `  Raw: ${line}`);
                }
              });
            });
            
            lastPosition = stats.size;
          }
        } catch (error) {
          // File might not exist yet or be locked
        }
      };
      
      // Watch for changes to this log file
      fs.watchFile(logPath, { interval: 500 }, watchLog);
    }
  });
}

function main() {
  colorLog('bright', '🚀 Starting MCP OAuth Server Monitor');
  
  const logsDir = path.join(__dirname, 'logs');
  
  // Start monitoring logs
  monitorLogs(logsDir);
  
  // Start the MCP server
  colorLog('green', '🔄 Starting MCP OAuth Server...');
  const child = spawn('node', ['mcp-server-spec-compliant.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: __dirname
  });

  const statusInterval = monitorProcess(child);

  child.stdout.on('data', (data) => {
    colorLog('green', `STDOUT: ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    colorLog('yellow', `STDERR: ${data.toString().trim()}`);
  });

  child.on('error', (error) => {
    colorLog('red', `❌ Process error: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    clearInterval(statusInterval);
    if (signal) {
      colorLog('red', `💀 Process killed by signal: ${signal}`);
    } else {
      colorLog('red', `💀 Process exited with code: ${code}`);
    }
    
    if (code === 137) {
      colorLog('red', '🔥 EXIT CODE 137 - Process was killed (likely by system or OOM killer)');
      colorLog('yellow', '   This usually indicates:');
      colorLog('yellow', '   - Out of memory');
      colorLog('yellow', '   - System resource limits');
      colorLog('yellow', '   - Manual kill -9');
      colorLog('yellow', '   - Container memory limit exceeded');
    }
    
    setTimeout(() => {
      colorLog('blue', '🔄 Restarting server in 3 seconds...');
      setTimeout(main, 3000);
    }, 1000);
  });

  child.on('close', (code, signal) => {
    colorLog('blue', `🔒 Process closed - code: ${code}, signal: ${signal}`);
  });
}

// Check system resources
function checkSystemResources() {
  const memUsage = process.memoryUsage();
  colorLog('blue', `💻 System Status:`);
  colorLog('blue', `   Node.js: ${process.version}`);
  colorLog('blue', `   Platform: ${process.platform}`);
  colorLog('blue', `   Memory Usage: ${Math.floor(memUsage.rss / 1024 / 1024)}MB`);
  colorLog('blue', `   Process PID: ${process.pid}`);
  colorLog('blue', `   Working Directory: ${process.cwd()}`);
}

checkSystemResources();
main();