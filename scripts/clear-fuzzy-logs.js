#!/usr/bin/env node

import { fuzzySearchLogger } from '../dist/utils/fuzzySearchLogger.js';

// Simple argument parsing
const args = process.argv.slice(2);
let skipConfirmation = false;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--yes' || args[i] === '-y') {
    skipConfirmation = true;
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Clear fuzzy search logs

Usage: node clear-fuzzy-logs.js [options]

Options:
  -y, --yes   Skip confirmation prompt
  -h, --help  Show this help message`);
  process.exit(0);
}

async function clearLogs() {
  try {
    const logPath = await fuzzySearchLogger.getLogPath();
    
    if (!skipConfirmation) {
      console.log(`About to clear fuzzy search logs at: ${logPath}`);
      console.log('This action cannot be undone. Continue? (y/N)');
      
      process.stdin.setRawMode(true);
      process.stdin.resume();
      
      const answer = await new Promise((resolve) => {
        process.stdin.on('data', (key) => {
          process.stdin.setRawMode(false);
          resolve(key.toString().toLowerCase());
        });
      });
      
      if (answer !== 'y') {
        console.log('Operation cancelled.');
        process.exit(0);
      }
    }
    
    await fuzzySearchLogger.clearLog();
    console.log(`✅ Fuzzy search logs cleared successfully.`);
    console.log(`Log file location: ${logPath}`);
    
  } catch (error) {
    console.error('Failed to clear fuzzy search logs:', error.message);
    process.exit(1);
  }
}

clearLogs();
