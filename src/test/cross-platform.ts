import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getAllowedDirectories } from '../config.js';
import { validatePath } from '../tools/filesystem.js';

interface TestResult {
  name: string;
  platform: string;
  passed: boolean;
  message?: string;
}

async function runPathTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const platform = os.platform();
  
  // Test home directory expansion
  try {
    const homePath = '~/test-file.txt';
    const expandedPath = await validatePath(homePath);
    const expectedPath = path.join(os.homedir(), 'test-file.txt');
    
    results.push({
      name: 'Home directory expansion',
      platform,
      passed: expandedPath.includes(os.homedir()),
      message: `Expanded ${homePath} to ${expandedPath}`
    });
  } catch (error) {
    results.push({
      name: 'Home directory expansion',
      platform,
      passed: false,
      message: `Error: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  
  // Test relative path resolution
  try {
    const relativePath = './test-file.txt';
    const expandedPath = await validatePath(relativePath);
    
    results.push({
      name: 'Relative path resolution',
      platform,
      passed: expandedPath.includes(process.cwd()),
      message: `Resolved ${relativePath} to ${expandedPath}`
    });
  } catch (error) {
    results.push({
      name: 'Relative path resolution',
      platform,
      passed: false,
      message: `Error: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  
  // Test path normalization
  try {
    const weirdPath = path.join('.', '..', 'current-dir', '..', 'current-dir', 'test-file.txt');
    const expandedPath = await validatePath(weirdPath);
    
    results.push({
      name: 'Path normalization',
      platform,
      passed: !expandedPath.includes('..'),
      message: `Normalized ${weirdPath} to ${expandedPath}`
    });
  } catch (error) {
    results.push({
      name: 'Path normalization',
      platform,
      passed: false,
      message: `Error: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  
  // Test path security (attempt to access outside allowed directories)
  try {
    const outsidePath = '/etc/passwd';
    await validatePath(outsidePath);
    
    results.push({
      name: 'Path security check',
      platform,
      passed: false,
      message: `Security failure: allowed access to ${outsidePath}`
    });
  } catch (error) {
    results.push({
      name: 'Path security check',
      platform,
      passed: true,
      message: `Correctly blocked access to /etc/passwd with error: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  
  return results;
}

async function runFileOperationTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const platform = os.platform();
  const tempDir = os.tmpdir();
  const testDir = path.join(tempDir, 'claude-commander-test');
  
  // Test file creation and reading
  try {
    // Create test directory if it doesn't exist
    await fs.mkdir(testDir, { recursive: true });
    
    // Write test file
    const testFilePath = path.join(testDir, 'test-file.txt');
    const testContent = 'Cross-platform test content';
    await fs.writeFile(testFilePath, testContent);
    
    // Read test file
    const readContent = await fs.readFile(testFilePath, 'utf8');
    
    results.push({
      name: 'File creation and reading',
      platform,
      passed: readContent === testContent,
      message: `Created and read file with ${readContent.length} bytes`
    });
    
    // Clean up
    await fs.unlink(testFilePath);
  } catch (error) {
    results.push({
      name: 'File creation and reading',
      platform,
      passed: false,
      message: `Error: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  
  // Test directory creation and listing
  try {
    const nestedDir = path.join(testDir, 'level1', 'level2');
    await fs.mkdir(nestedDir, { recursive: true });
    
    const dirExists = await fs.stat(nestedDir).then(() => true).catch(() => false);
    
    results.push({
      name: 'Directory creation and nesting',
      platform,
      passed: dirExists,
      message: `Created nested directory ${nestedDir}`
    });
    
    // Clean up
    await fs.rm(path.join(testDir, 'level1'), { recursive: true });
  } catch (error) {
    results.push({
      name: 'Directory creation and nesting',
      platform,
      passed: false,
      message: `Error: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  
  return results;
}

export async function runAllTests(): Promise<void> {
  console.log('Running cross-platform tests...');
  console.log('Platform:', os.platform(), os.release());
  console.log('Architecture:', os.arch());
  console.log('Allowed directories:', getAllowedDirectories());
  
  const pathResults = await runPathTests();
  const fileResults = await runFileOperationTests();
  
  const allResults = [...pathResults, ...fileResults];
  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  
  console.log('\nTest Results:');
  console.log(`${passed} passed, ${failed} failed\n`);
  
  allResults.forEach(result => {
    console.log(`${result.passed ? '✅' : '❌'} ${result.name}`);
    if (result.message) {
      console.log(`   ${result.message}`);
    }
  });
  
  if (failed > 0) {
    console.error('\nSome tests failed!');
    process.exit(1);
  } else {
    console.log('\nAll tests passed successfully!');
  }
}

// Run tests if this file is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAllTests().catch(error => {
    console.error('Test runner failed:', error);
    process.exit(1);
  });
}

export { runAllTests, runPathTests, runFileOperationTests };