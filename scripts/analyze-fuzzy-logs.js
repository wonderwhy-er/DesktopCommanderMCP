#!/usr/bin/env node

import { fuzzySearchLogger } from '../dist/utils/fuzzySearchLogger.js';

// Simple argument parsing
const args = process.argv.slice(2);
let failureThreshold = 0.7;
let limit = 100;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--threshold' || args[i] === '-t') {
    failureThreshold = parseFloat(args[i + 1]) || 0.7;
  }
  if (args[i] === '--limit' || args[i] === '-l') {
    limit = parseInt(args[i + 1], 10) || 100;
  }
  if (args[i].startsWith('--threshold=')) {
    failureThreshold = parseFloat(args[i].split('=')[1]) || 0.7;
  }
  if (args[i].startsWith('--limit=')) {
    limit = parseInt(args[i].split('=')[1], 10) || 100;
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Analyze fuzzy search logs for patterns and issues

Usage: node analyze-fuzzy-logs.js [options]

Options:
  -t, --threshold <number>  Failure threshold (0-1) (default: 0.7)
  -l, --limit <number>      Maximum number of logs to analyze (default: 100)
  -h, --help               Show this help message`);
  process.exit(0);
}

async function analyzeLogs() {
  try {
    const logs = await fuzzySearchLogger.getRecentLogs(limit);
    const logPath = await fuzzySearchLogger.getLogPath();
    
    if (logs.length === 0) {
      console.log(`No fuzzy search logs found. Log file location: ${logPath}`);
      return;
    }
    
    console.log('\n=== Fuzzy Search Analysis ===\n');
    
    // Parse logs and gather statistics
    let totalEntries = 0;
    let exactMatches = 0;
    let fuzzyMatches = 0;
    let failures = 0;
    let belowThresholdCount = 0;
    const executionTimes = [];
    const similarities = [];
    const fileExtensions = new Map();
    const commonCharacterCodes = new Map();
    const failureReasons = [];
    
    for (const log of logs) {
      const parts = log.split('\t');
      if (parts.length >= 16) {
        totalEntries++;
        const [
          timestamp, searchText, foundText, similarity, 
          executionTime, exactMatchCount, expectedReplacements,
          fuzzyThreshold, belowThreshold, diff,
          searchLength, foundLength, fileExtension,
          characterCodes, uniqueCharacterCount, diffLength
        ] = parts;
        
        const simValue = parseFloat(similarity);
        const execTime = parseFloat(executionTime);
        const exactCount = parseInt(exactMatchCount);
        const belowThresh = belowThreshold === 'true';
        
        if (exactCount > 0) {
          exactMatches++;
        } else if (simValue >= failureThreshold) {
          fuzzyMatches++;
        } else {
          failures++;
          // Store failure case for analysis
          failureReasons.push({
            similarity: simValue,
            diff: diff.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
            fileExtension,
            characterCodes
          });
        }
        
        if (belowThresh) {
          belowThresholdCount++;
        }
        
        executionTimes.push(execTime);
        similarities.push(simValue);
        
        // Track file extensions
        fileExtensions.set(fileExtension, (fileExtensions.get(fileExtension) || 0) + 1);
        
        // Track character codes that appear in diffs
        if (characterCodes && characterCodes !== '') {
          const codes = characterCodes.split(',');
          for (const code of codes) {
            const key = code.split(':')[0];
            commonCharacterCodes.set(key, (commonCharacterCodes.get(key) || 0) + 1);
          }
        }
      }
    }
    
    // Calculate statistics
    const avgExecutionTime = executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length;
    const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const maxExecutionTime = Math.max(...executionTimes);
    const minExecutionTime = Math.min(...executionTimes);
    
    // Sort by frequency
    const sortedExtensions = Array.from(fileExtensions.entries()).sort((a, b) => b[1] - a[1]);
    const sortedCharCodes = Array.from(commonCharacterCodes.entries()).sort((a, b) => b[1] - a[1]);
    
    // Display results
    console.log(`Total Entries: ${totalEntries}`);
    console.log(`Exact Matches: ${exactMatches} (${((exactMatches / totalEntries) * 100).toFixed(2)}%)`);
    console.log(`Fuzzy Matches: ${fuzzyMatches} (${((fuzzyMatches / totalEntries) * 100).toFixed(2)}%)`);
    console.log(`Failures: ${failures} (${((failures / totalEntries) * 100).toFixed(2)}%)`);
    console.log(`Below Threshold: ${belowThresholdCount} (${((belowThresholdCount / totalEntries) * 100).toFixed(2)}%)`);
    
    console.log('\n--- Performance Metrics ---');
    console.log(`Average Execution Time: ${avgExecutionTime.toFixed(2)}ms`);
    console.log(`Min Execution Time: ${minExecutionTime.toFixed(2)}ms`);
    console.log(`Max Execution Time: ${maxExecutionTime.toFixed(2)}ms`);
    console.log(`Average Similarity: ${(avgSimilarity * 100).toFixed(2)}%`);
    
    console.log('\n--- File Extensions (Top 5) ---');
    sortedExtensions.slice(0, 5).forEach(([ext, count]) => {
      console.log(`${ext || 'none'}: ${count} times`);
    });
    
    console.log('\n--- Common Character Codes in Diffs (Top 10) ---');
    sortedCharCodes.slice(0, 10).forEach(([code, count]) => {
      const charCode = parseInt(code);
      const char = String.fromCharCode(charCode);
      const display = charCode < 32 || charCode > 126 ? `\\x${charCode.toString(16).padStart(2, '0')}` : char;
      console.log(`${code} [${display}]: ${count} times`);
    });
    
    // Analyze failure patterns
    if (failures > 0) {
      console.log('\n--- Failure Analysis ---');
      console.log(`Total failures: ${failures}`);
      
      // Group failures by similarity ranges
      const similarityRanges = {
        '0-20%': 0,
        '21-40%': 0,
        '41-60%': 0,
        '61-80%': 0,
        '81-99%': 0
      };
      
      failureReasons.forEach(failure => {
        const sim = failure.similarity * 100;
        if (sim <= 20) similarityRanges['0-20%']++;
        else if (sim <= 40) similarityRanges['21-40%']++;
        else if (sim <= 60) similarityRanges['41-60%']++;
        else if (sim <= 80) similarityRanges['61-80%']++;
        else similarityRanges['81-99%']++;
      });
      
      console.log('\nFailures by similarity range:');
      Object.entries(similarityRanges).forEach(([range, count]) => {
        if (count > 0) {
          console.log(`  ${range}: ${count} failures`);
        }
      });
      
      // Show most common failure reasons
      const failuresByExtension = new Map();
      failureReasons.forEach(failure => {
        const key = failure.fileExtension || 'none';
        failuresByExtension.set(key, (failuresByExtension.get(key) || 0) + 1);
      });
      
      console.log('\nFailures by file extension:');
      Array.from(failuresByExtension.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([ext, count]) => {
          console.log(`  ${ext}: ${count} failures`);
        });
    }
    
    // Recommendations
    console.log('\n--- Recommendations ---');
    if (failures > totalEntries * 0.1) {
      console.log(`⚠️  High failure rate (${((failures / totalEntries) * 100).toFixed(1)}%). Consider:
  - Reviewing search text formatting (whitespace, line endings)
  - Checking for encoding issues
  - Using smaller, more specific search patterns`);
    }
    
    if (avgExecutionTime > 100) {
      console.log(`⚠️  Slow execution times (avg: ${avgExecutionTime.toFixed(2)}ms). Consider:
  - Reducing search text length
  - Breaking large edits into smaller chunks`);
    }
    
    if (sortedCharCodes.length > 0) {
      const topCharCode = sortedCharCodes[0];
      const charCode = parseInt(topCharCode[0]);
      if (charCode === 13 || charCode === 10) {
        console.log(`💡 Most common character differences involve line endings (CR/LF).
  Consider normalizing line endings in your search text.`);
      } else if (charCode === 32 || charCode === 9) {
        console.log(`💡 Most common character differences involve whitespace.
  Consider trimming whitespace or being more specific about spacing.`);
      }
    }
    
    console.log(`\nLog file location: ${logPath}`);
    console.log(`Analysis completed for ${totalEntries} entries.`);
    
  } catch (error) {
    console.error('Failed to analyze fuzzy search logs:', error.message);
    process.exit(1);
  }
}

analyzeLogs();
