import assert from 'assert';
import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';

/**
 * Regression test for issue #628: a multibyte UTF-8 character split across
 * two stdout 'data' chunks decoded to U+FFFD replacement characters instead
 * of the original character, because each chunk was decoded independently.
 *
 * This test should:
 * - FAIL when the bug exists (current behavior)
 * - PASS when the bug is fixed (desired behavior)
 */
async function testUtf8SplitAcrossChunks() {
  console.log('Testing UTF-8 character split across two stdout chunks...');

  // The euro sign (U+20AC) is the 3-byte UTF-8 sequence 0xE2 0x82 0xAC.
  // Write the first 2 bytes, then (after a delay long enough to force two
  // separate 'data' events) write the final byte.
  const command = 'node -e "' +
    'process.stdout.write(Buffer.from([0xE2,0x82]));' +
    'setTimeout(() => process.stdout.write(Buffer.from([0xAC])), 400);' +
    '"';

  const startResult = await startProcess({
    command,
    timeout_ms: 100 // returns well before the second chunk is written
  });

  const pidMatch = startResult.content[0].text.match(/Process started with PID (\d+)/);
  assert(pidMatch, 'Should get PID from start_process');
  const pid = parseInt(pidMatch[1]);

  // Wait for both chunks to have been written and the process to exit.
  await new Promise(resolve => setTimeout(resolve, 1500));

  const readResult = await readProcessOutput({ pid, timeout_ms: 1000 });
  assert(!readResult.isError, 'Should be able to read the completed process output');

  const text = readResult.content[0].text;
  assert(!text.includes('�'),
    `Output should not contain a replacement character from a mis-decoded chunk boundary, got: ${JSON.stringify(text)}`);
  assert(text.includes('€'),
    `Output should contain the euro sign reassembled across chunks, got: ${JSON.stringify(text)}`);

  console.log('Multibyte character correctly reassembled across chunk boundary');
}

async function runTests() {
  try {
    await testUtf8SplitAcrossChunks();
    console.log('\nAll tests passed - UTF-8 chunk boundaries are handled correctly!');
    return true;
  } catch (error) {
    console.log('\nTest failed:', error.message);
    console.log('This indicates the bug still exists:');
    console.log('   a multibyte character split across two stdout chunks decodes to U+FFFD');
    return false;
  }
}

runTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test error:', error);
    process.exit(1);
  });
