#!/usr/bin/env node

/**
 * Fuzzy Search Matcher Script
 * 
 * Usage: node fuzzy_matcher.js <search_file> <target_file>
 * 
 * This script reads text from the first file and searches for it in the second file
 * using the same fuzzy search algorithm used by edit_block. It shows:
 * - Similarity percentage
 * - Character-level diff output
 * - Execution time
 * - Match quality assessment
 */

import { recursiveFuzzyIndexOf, getSimilarityRatio } from './dist/tools/fuzzySearch.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Diff from 'diff';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Threshold used by edit_block (70%)
const FUZZY_THRESHOLD = 0.7;

/**
 * Generate character-level diff using the 'diff' library for professional results
 */
function highlightDifferences(expected, actual) {
    // Use the diff library for professional-grade character-level diffing
    const diffResult = Diff.diffChars(expected, actual);
    
    let result = '';
    for (const part of diffResult) {
        if (part.added) {
            result += `{+${part.value}+}`;
        } else if (part.removed) {
            result += `{-${part.value}-}`;
        } else {
            result += part.value;
        }
    }
    
    return result;
}

/**
 * Get character code analysis for debugging using diff library
 */
function getCharacterCodeData(expected, actual) {
    // Use the diff library to get precise differences
    const diffResult = Diff.diffChars(expected, actual);
    
    // Count unique character codes in the differences only
    const characterCodes = new Map();
    let totalDiffLength = 0;
    
    for (const part of diffResult) {
        if (part.added || part.removed) {
            totalDiffLength += part.value.length;
            for (let i = 0; i < part.value.length; i++) {
                const charCode = part.value.charCodeAt(i);
                const key = `${charCode}`;
                characterCodes.set(key, (characterCodes.get(key) || 0) + 1);
            }
        }
    }
    
    // Format as "code:count[char]"
    const report = Array.from(characterCodes.entries())
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([code, count]) => {
            const charCode = parseInt(code);
            const char = String.fromCharCode(charCode);
            const display = charCode < 32 || charCode > 126 ? `\\x${charCode.toString(16).padStart(2, '0')}` : char;
            return `${code}:${count}[${display}]`;
        })
        .join(',');
    
    return {
        report,
        uniqueCount: characterCodes.size,
        diffLength: totalDiffLength
    };
}

/**
 * Display usage information
 */
function showUsage() {
    console.log(`
Fuzzy Search Matcher

Usage: node fuzzy_matcher.js <search_file> <target_file> [options]

Arguments:
  search_file   File containing text to search for
  target_file   File to search within

Options:
  --help, -h    Show this help message
  --verbose, -v Show detailed character analysis
  --threshold   Custom similarity threshold (default: 0.7)

Examples:
  node fuzzy_matcher.js search.txt target.txt
  node fuzzy_matcher.js pattern.js source.js --verbose
  node fuzzy_matcher.js --threshold 0.5 search.txt target.txt
`);
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        showUsage();
        process.exit(0);
    }
    
    const options = {
        verbose: args.includes('--verbose') || args.includes('-v'),
        threshold: FUZZY_THRESHOLD
    };
    
    // Parse threshold
    const thresholdIndex = args.findIndex(arg => arg === '--threshold');
    if (thresholdIndex !== -1 && args[thresholdIndex + 1]) {
        options.threshold = parseFloat(args[thresholdIndex + 1]) || FUZZY_THRESHOLD;
    }
    
    // Get file arguments (excluding flags)
    const files = args.filter(arg => !arg.startsWith('-') && arg !== options.threshold.toString());
    
    if (files.length !== 2) {
        console.error('❌ Error: Exactly two files must be specified');
        showUsage();
        process.exit(1);
    }
    
    return {
        searchFile: files[0],
        targetFile: files[1],
        ...options
    };
}

/**
 * Main fuzzy matching function
 */
async function runFuzzyMatch() {
    try {
        const { searchFile, targetFile, verbose, threshold } = parseArgs();
        
        console.log('=== Fuzzy Search Matcher ===\n');
        console.log(`Search file: ${searchFile}`);
        console.log(`Target file: ${targetFile}`);
        console.log(`Threshold: ${(threshold * 100).toFixed(0)}%\n`);
        
        // Read files
        console.log('📖 Reading files...');
        let searchText, targetText;
        
        try {
            searchText = await fs.readFile(searchFile, 'utf8');
            targetText = await fs.readFile(targetFile, 'utf8');
        } catch (error) {
            console.error('❌ Error reading files:', error.message);
            process.exit(1);
        }
        
        console.log(`Search text length: ${searchText.length} characters`);
        console.log(`Target text length: ${targetText.length} characters\n`);
        
        // Perform fuzzy search
        console.log('🔍 Performing fuzzy search...');
        const startTime = performance.now();
        
        const fuzzyResult = recursiveFuzzyIndexOf(targetText, searchText);
        const similarity = getSimilarityRatio(searchText, fuzzyResult.value);
        
        const executionTime = performance.now() - startTime;
        
        // Generate diff and character analysis
        const diff = highlightDifferences(searchText, fuzzyResult.value);
        const charData = getCharacterCodeData(searchText, fuzzyResult.value);
        
        // Display results
        console.log('\n📊 RESULTS:');
        console.log('='.repeat(60));
        
        console.log(`Similarity: ${(similarity * 100).toFixed(2)}%`);
        console.log(`Execution time: ${executionTime.toFixed(2)}ms`);
        console.log(`Match quality: ${similarity >= threshold ? '✅ GOOD' : '❌ POOR'} (threshold: ${(threshold * 100).toFixed(0)}%)`);
        
        console.log('\n📝 FOUND TEXT:');
        console.log('-'.repeat(40));
        // Show found text with some context, but limit length
        const displayText = fuzzyResult.value;
        console.log(`"${displayText}"`);
        
        console.log('\n🔄 DIFF:');
        console.log('-'.repeat(40));
        // Limit diff display length for readability
        const displayDiff = diff;
        console.log(displayDiff);
        
        if (verbose) {
            console.log('\n🔍 DETAILED ANALYSIS:');
            console.log('-'.repeat(40));
            console.log(`Search text start: "${searchText.substring(0, 50)}${searchText.length > 50 ? '...' : ''}"`);
            console.log(`Found text start: "${fuzzyResult.value.substring(0, 50)}${fuzzyResult.value.length > 50 ? '...' : ''}"`);
            console.log(`Character differences: ${charData.uniqueCount} unique characters`);
            console.log(`Total diff length: ${charData.diffLength} characters`);
            console.log(`Character codes: ${charData.report}`);
            console.log(`Found at position: ${fuzzyResult.start}-${fuzzyResult.end} in target file`);
        }
        
        // Summary and recommendations
        console.log('\n💡 ASSESSMENT:');
        console.log('-'.repeat(40));
        
        if (similarity >= threshold) {
            console.log('✅ This would be accepted by edit_block fuzzy search');
            console.log('   The text is similar enough to be considered a match');
        } else {
            console.log('❌ This would be rejected by edit_block fuzzy search');
            console.log('   The text is too different to be considered a match');
        }
        
        if (similarity > 0.9) {
            console.log('💡 Very high similarity - likely just whitespace or minor typos');
        } else if (similarity > 0.7) {
            console.log('💡 Good similarity - some differences but recognizable');
        } else if (similarity > 0.5) {
            console.log('💡 Moderate similarity - significant differences');
        } else {
            console.log('💡 Low similarity - very different texts');
        }
        
        console.log('\n✅ Fuzzy search completed successfully!');
        
    } catch (error) {
        console.error('❌ Unexpected error:', error);
        process.exit(1);
    }
}

// Run the script
runFuzzyMatch();
