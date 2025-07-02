// Test script to verify line limit enforcement
import { writeFile } from './dist/tools/filesystem.js';
import fs from 'fs/promises';

async function runTest() {
  try {
    console.log('Reading test file...');
    const content = await fs.readFile('./test_large_write/large_file.txt', 'utf8');
    const lineCount = content.split('\n').length;
    console.log(`Test file has ${lineCount} lines`);
    
    console.log('Attempting to write file that exceeds line limit...');
    await writeFile('./test_large_write/output.txt', content, 'rewrite');
    console.log('SUCCESS - File was written (THIS SHOULD NOT HAPPEN)');
  } catch (error) {
    console.log('EXPECTED ERROR - Line limit enforced properly:');
    console.log(error.message);
  }
}

runTest().catch(err => console.error('Unexpected error:', err));
