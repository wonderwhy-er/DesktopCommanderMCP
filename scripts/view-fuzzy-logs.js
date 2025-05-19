#!/usr/bin/env node

import { fuzzySearchLogger } from '../dist/utils/fuzzySearchLogger.js';

// Simple argument parsing
const args = process.argv.slice(2);
let count = 10;

// Parse --count or -c argument
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--count' || args[i] === '-c') {
    count = parseInt(args[i + 1], 10) || 10;
    break;
  }
  if (args[i].startsWith('--count=')) {
    count = parseInt(args[i].split('=')[1], 10) || 10;
    break;
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`View recent fuzzy search logs

Usage: node view-fuzzy-logs.js [options]

Options:
  -c, --count <number>  Number of recent logs to show (default: 10)
  -h, --help           Show this help message`);
  process.exit(0);
}

async function viewLogs() {
  try {
    const logs = await fuzzySearchLogger.getRecentLogs(count);
    const logPath = await fuzzySearchLogger.getLogPath();
    
    if (logs.length === 0) {
      console.log(`No fuzzy search logs found. Log file location: ${logPath}`);
      return;
    }
    
    console.log(`\nRecent Fuzzy Search Logs (${logs.length} entries):\n`);
    console.log('='.repeat(60));
    
    // Parse and format logs for better readability
    logs.forEach((log, index) => {
      const parts = log.split('\t');
      if (parts.length >= 16) {
        const [
          timestamp, searchText, foundText, similarity, 
          executionTime, exactMatchCount, expectedReplacements,
          fuzzyThreshold, belowThreshold, diff,
          searchLength, foundLength, fileExtension,
          characterCodes, uniqueCharacterCount, diffLength
        ] = parts;
        
        console.log(`\n--- Log Entry ${index + 1} ---`);
        console.log(`Timestamp: ${timestamp}`);
        console.log(`File Extension: ${fileExtension}`);
        console.log(`Search Text:\n${searchText.replace(/\\n/g, '\n').replace(/\\t/g, '\t')}`);
        console.log(`Found Text:\n${foundText.replace(/\\n/g, '\n').replace(/\\t/g, '\t')}`);
        console.log(`Similarity: ${(parseFloat(similarity) * 100).toFixed(2)}%`);
        console.log(`Execution Time: ${parseFloat(executionTime).toFixed(2)}ms`);
        console.log(`Exact Match Count: ${exactMatchCount}`);
        console.log(`Expected Replacements: ${expectedReplacements}`);
        console.log(`Below Threshold: ${belowThreshold}`);
        console.log(`Diff:\n${diff.replace(/\\n/g, '\n').replace(/\\t/g, '\t')}`);
        console.log(`Search Length: ${searchLength}`);
        console.log(`Found Length: ${foundLength}`);
        console.log(`Character Codes: ${characterCodes}`);
        console.log(`Unique Characters: ${uniqueCharacterCount}`);
        console.log(`Diff Length: ${diffLength}`);
      } else {
        console.log(`Malformed log entry: ${log}`);
      }
    });
    
    console.log(`\nLog file location: ${logPath}`);
  } catch (error) {
    console.error('Failed to view fuzzy search logs:', error.message);
    process.exit(1);
  }
}

viewLogs();
