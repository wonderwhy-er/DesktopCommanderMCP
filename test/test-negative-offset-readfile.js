/**
 * Test script for negative offset handling in read_file
 * 
 * This script tests:
 * 1. Whether negative offsets work correctly (like Unix tail)
 * 2. How the tool handles edge cases with negative offsets
 * 3. Comparison with positive offset behavior
 * 4. Error handling for invalid parameters
 */

import { configManager } from '../dist/config-manager.js';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define test paths
const TEST_FILE = path.join(__dirname, 'test-negative-offset.txt');

/**
 * Setup function to prepare test environment
 */
async function setup() {
  console.log('🔧 Setting up negative offset test...');
  
  // Save original config to restore later
  const originalConfig = await configManager.getConfig();
  
  // Set allowed directories to include test directory
  await configManager.setValue('allowedDirectories', [__dirname]);
  
  // Create test file with numbered lines for easy verification
  const testLines = [];
  for (let i = 1; i <= 50; i++) {
    testLines.push(`Line ${i}: This is line number ${i} in the test file.`);
  }
  const testContent = testLines.join('\n');
  
  await fs.writeFile(TEST_FILE, testContent, 'utf8');
  console.log(`✓ Created test file with 50 lines: ${TEST_FILE}`);
  
  return originalConfig;
}

/**
 * Teardown function to clean up after tests
 */
async function teardown(originalConfig) {
  console.log('🧹 Cleaning up test environment...');
  
  // Reset configuration to original
  await configManager.updateConfig(originalConfig);
  
  // Remove test file
  try {
    await fs.rm(TEST_FILE, { force: true });
    console.log('✓ Test file cleaned up');
  } catch (error) {
    console.log('⚠️  Warning: Could not clean up test file:', error.message);
  }
}

/**
 * Test negative offset functionality
 */
async function testNegativeOffset() {
  console.log('\n📋 Testing negative offset behavior...');
  
  const tests = [
    {
      name: 'Negative offset -10 (last 10 lines)',
      args: { path: TEST_FILE, offset: -10, length: 20 },
      expectLines: ['Line 41:', 'Line 42:', 'Line 43:', 'Line 44:', 'Line 45:', 'Line 46:', 'Line 47:', 'Line 48:', 'Line 49:', 'Line 50:']
    },
    {
      name: 'Negative offset -5 (last 5 lines)',
      args: { path: TEST_FILE, offset: -5, length: 10 },
      expectLines: ['Line 46:', 'Line 47:', 'Line 48:', 'Line 49:', 'Line 50:']
    },
    {
      name: 'Negative offset -1 (last 1 line)',
      args: { path: TEST_FILE, offset: -1, length: 5 },
      expectLines: ['Line 50:']
    },
    {
      name: 'Large negative offset -100 (beyond file size)',
      args: { path: TEST_FILE, offset: -100, length: 10 },
      expectLines: ['Line 1:', 'Line 2:', 'Line 3:', 'Line 4:', 'Line 5:', 'Line 6:', 'Line 7:', 'Line 8:', 'Line 9:', 'Line 10:']
    }
  ];
  
  let passedTests = 0;
  
  for (const test of tests) {
    console.log(`\n  🧪 ${test.name}`);
    
    try {
      const result = await handleReadFile(test.args);
      
      if (result.isError) {
        console.log(`  ❌ Error: ${result.content[0].text}`);
        continue;
      }
      
      const content = result.content[0].text;
      console.log(`  📄 Result (first 200 chars): ${content.substring(0, 200)}...`);
      
      // Check if expected lines are present
      let foundExpected = 0;
      for (const expectedLine of test.expectLines) {
        if (content.includes(expectedLine)) {
          foundExpected++;
        }
      }
      
      if (foundExpected === test.expectLines.length) {
        console.log(`  ✅ PASS: Found all ${foundExpected} expected lines`);
        passedTests++;
      } else {
        console.log(`  ❌ FAIL: Found only ${foundExpected}/${test.expectLines.length} expected lines`);
        console.log(`  Expected: ${test.expectLines.join(', ')}`);
      }
      
    } catch (error) {
      console.log(`  ❌ Exception: ${error.message}`);
    }
  }
  
  return passedTests === tests.length;
}

/**
 * Test comparison between negative and positive offsets
 */
async function testOffsetComparison() {
  console.log('\n📊 Testing offset comparison (negative vs positive)...');
  
  try {
    // Test reading last 5 lines with negative offset
    const negativeResult = await handleReadFile({
      path: TEST_FILE,
      offset: -5,
      length: 10
    });
    
    // Test reading same lines with positive offset (45 to get last 5 lines of 50)
    const positiveResult = await handleReadFile({
      path: TEST_FILE,
      offset: 45,
      length: 5
    });
    
    if (negativeResult.isError || positiveResult.isError) {
      console.log('  ❌ One or both requests failed');
      return false;
    }
    
    const negativeContent = negativeResult.content[0].text;
    const positiveContent = positiveResult.content[0].text;
    
    console.log('  📄 Negative offset result:');
    console.log(`    ${negativeContent.split('\n').slice(2, 4).join('\\n')}`); // Skip header lines
    
    console.log('  📄 Positive offset result:');
    console.log(`    ${positiveContent.split('\n').slice(2, 4).join('\\n')}`); // Skip header lines
    
    // Extract actual content lines (skip informational headers)
    const negativeLines = negativeContent.split('\n').filter(line => line.startsWith('Line '));
    const positiveLines = positiveContent.split('\n').filter(line => line.startsWith('Line '));
    
    const isMatching = negativeLines.join('\\n') === positiveLines.join('\\n');
    
    if (isMatching) {
      console.log('  ✅ PASS: Negative and positive offsets return same content');
      return true;
    } else {
      console.log('  ❌ FAIL: Negative and positive offsets return different content');
      console.log(`    Negative: ${negativeLines.slice(0, 2).join(', ')}`);
      console.log(`    Positive: ${positiveLines.slice(0, 2).join(', ')}`);
      return false;
    }
    
  } catch (error) {
    console.log(`  ❌ Exception during comparison: ${error.message}`);
    return false;
  }
}

/**
 * Test edge cases and error handling
 */
async function testEdgeCases() {
  console.log('\n🔍 Testing edge cases...');
  
  const edgeTests = [
    {
      name: 'Zero offset with length',
      args: { path: TEST_FILE, offset: 0, length: 3 },
      shouldPass: true
    },
    {
      name: 'Very large negative offset',
      args: { path: TEST_FILE, offset: -1000, length: 5 },
      shouldPass: true // Should handle gracefully
    },
    {
      name: 'Negative offset with zero length',
      args: { path: TEST_FILE, offset: -5, length: 0 },
      shouldPass: true // Should return empty or minimal content
    }
  ];
  
  let passedEdgeTests = 0;
  
  for (const test of edgeTests) {
    console.log(`\n  🧪 ${test.name}`);
    
    try {
      const result = await handleReadFile(test.args);
      
      if (result.isError && test.shouldPass) {
        console.log(`  ❌ Unexpected error: ${result.content[0].text}`);
      } else if (!result.isError && test.shouldPass) {
        console.log(`  ✅ PASS: Handled gracefully`);
        console.log(`  📄 Result length: ${result.content[0].text.length} chars`);
        passedEdgeTests++;
      } else if (result.isError && !test.shouldPass) {
        console.log(`  ✅ PASS: Expected error occurred`);
        passedEdgeTests++;
      }
      
    } catch (error) {
      if (test.shouldPass) {
        console.log(`  ❌ Unexpected exception: ${error.message}`);
      } else {
        console.log(`  ✅ PASS: Expected exception occurred`);
        passedEdgeTests++;
      }
    }
  }
  
  return passedEdgeTests === edgeTests.length;
}

/**
 * Main test runner
 */
async function runAllTests() {
  console.log('🧪 Starting negative offset read_file tests...\n');
  
  let originalConfig;
  let allTestsPassed = true;
  
  try {
    originalConfig = await setup();
    
    // Run all test suites
    const negativeOffsetPassed = await testNegativeOffset();
    const comparisonPassed = await testOffsetComparison();
    const edgeCasesPassed = await testEdgeCases();
    
    allTestsPassed = negativeOffsetPassed && comparisonPassed && edgeCasesPassed;
    
    console.log('\n📊 Test Results Summary:');
    console.log(`  Negative offset tests: ${negativeOffsetPassed ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  Comparison tests: ${comparisonPassed ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  Edge case tests: ${edgeCasesPassed ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`\n🎯 Overall result: ${allTestsPassed ? '✅ ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'}`);
    
  } catch (error) {
    console.error('❌ Test setup/execution failed:', error.message);
    allTestsPassed = false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
  
  return allTestsPassed;
}

// Export the main test function
export default runAllTests;

// If this file is run directly (not imported), execute the test
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}