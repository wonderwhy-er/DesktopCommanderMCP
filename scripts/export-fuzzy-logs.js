#!/usr/bin/env node

import { fuzzySearchLogger } from '../dist/utils/fuzzySearchLogger.js';
import fs from 'fs/promises';

// Simple argument parsing
const args = process.argv.slice(2);
let format = 'csv';
let outputFile = null;
let limit = 1000;

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--format' || args[i] === '-f') {
    format = args[i + 1]?.toLowerCase() || 'csv';
  }
  if (args[i] === '--output' || args[i] === '-o') {
    outputFile = args[i + 1];
  }
  if (args[i] === '--limit' || args[i] === '-l') {
    limit = parseInt(args[i + 1], 10) || 1000;
  }
  if (args[i].startsWith('--format=')) {
    format = args[i].split('=')[1]?.toLowerCase() || 'csv';
  }
  if (args[i].startsWith('--output=')) {
    outputFile = args[i].split('=')[1];
  }
  if (args[i].startsWith('--limit=')) {
    limit = parseInt(args[i].split('=')[1], 10) || 1000;
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Export fuzzy search logs to CSV or JSON format

Usage: node export-fuzzy-logs.js [options]

Options:
  -f, --format <format>  Export format (csv|json) (default: csv)
  -o, --output <file>    Output file path (auto-generated if not specified)
  -l, --limit <number>   Maximum number of logs to export (default: 1000)
  -h, --help            Show this help message`);
  process.exit(0);
}

async function exportLogs() {
  try {
    const logs = await fuzzySearchLogger.getRecentLogs(limit);
    const logPath = await fuzzySearchLogger.getLogPath();
    
    if (logs.length === 0) {
      console.log(`No fuzzy search logs found. Log file location: ${logPath}`);
      return;
    }
    
    // Parse logs into structured data
    const parsedLogs = logs.map(log => {
      const parts = log.split('\t');
      if (parts.length >= 16) {
        const [
          timestamp, searchText, foundText, similarity, 
          executionTime, exactMatchCount, expectedReplacements,
          fuzzyThreshold, belowThreshold, diff,
          searchLength, foundLength, fileExtension,
          characterCodes, uniqueCharacterCount, diffLength
        ] = parts;
        
        return {
          timestamp,
          searchText: searchText.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
          foundText: foundText.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
          similarity: parseFloat(similarity),
          executionTime: parseFloat(executionTime),
          exactMatchCount: parseInt(exactMatchCount),
          expectedReplacements: parseInt(expectedReplacements),
          fuzzyThreshold: parseFloat(fuzzyThreshold),
          belowThreshold: belowThreshold === 'true',
          diff: diff.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
          searchLength: parseInt(searchLength),
          foundLength: parseInt(foundLength),
          fileExtension,
          characterCodes,
          uniqueCharacterCount: parseInt(uniqueCharacterCount),
          diffLength: parseInt(diffLength)
        };
      }
      return null;
    }).filter(Boolean);
    
    // Generate output filename if not provided
    if (!outputFile) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      outputFile = `fuzzy-search-logs-${timestamp}.${format}`;
    }
    
    // Export based on format
    let content;
    if (format === 'json') {
      content = JSON.stringify(parsedLogs, null, 2);
    } else if (format === 'csv') {
      // Create CSV headers
      const headers = Object.keys(parsedLogs[0]);
      const csvHeaders = headers.join(',');
      
      // Create CSV rows
      const csvRows = parsedLogs.map(log => {
        return headers.map(header => {
          let value = log[header];
          if (typeof value === 'string') {
            // Escape quotes and wrap in quotes if contains comma, newline, or quote
            value = value.replace(/"/g, '""');
            if (value.includes(',') || value.includes('\n') || value.includes('"')) {
              value = `"${value}"`;
            }
          }
          return value;
        }).join(',');
      });
      
      content = [csvHeaders, ...csvRows].join('\n');
    } else {
      throw new Error(`Unsupported format: ${format}. Use 'csv' or 'json'.`);
    }
    
    // Write to file
    await fs.writeFile(outputFile, content);
    
    console.log(`✅ Exported ${parsedLogs.length} fuzzy search logs to: ${outputFile}`);
    console.log(`Format: ${format.toUpperCase()}`);
    console.log(`Source log file: ${logPath}`);
    
  } catch (error) {
    console.error('Failed to export fuzzy search logs:', error.message);
    process.exit(1);
  }
}

exportLogs();
