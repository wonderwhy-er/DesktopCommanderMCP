import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { handleEditBlock } from './dist/handlers/edit-search-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testEditBlock() {
  // Create a simple test file with CRLF
  const testDir = path.join(__dirname, 'debug_test');
  fs.mkdirSync(testDir, { recursive: true });

  const crlfFile = path.join(testDir, 'test_crlf.txt');
  const content = 'First line with CRLF\r\nSecond line with CRLF\r\nREPLACED LINE WITH CRLF\r\nFourth line with CRLF\r\n';
  fs.writeFileSync(crlfFile, content);

  console.log('Testing edit_block with CRLF...');

  const result = await handleEditBlock({
    file_path: crlfFile,
    old_string: 'Second line with CRLF\\nREPLACED LINE WITH CRLF',
    new_string: 'New second line\\nAnother replacement',
    expected_replacements: 1
  });

  console.log('Result:', JSON.stringify(result, null, 2));

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
}

testEditBlock().catch(console.error);
