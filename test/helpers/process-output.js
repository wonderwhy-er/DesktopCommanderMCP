import assert from 'assert';
import { readProcessOutput } from '../../dist/tools/improved-process-tools.js';
import { waitUntil } from './wait.js';

// Reads new output (offset=0) until `done` holds for all the text read so far,
// for up to timeoutMs, then throws as waitUntil() does with `what`: a command can
// take most of a second to start (on Windows it starts through powershell.exe),
// so a fixed wait can end before its output
export async function readUntil(pid, done, timeoutMs, what) {
  let text = '';
  await waitUntil(async () => {
    const read = await readProcessOutput({ pid, timeout_ms: 300 });
    assert(!read.isError, `Read should succeed, got: ${read.content[0].text}`);
    text += read.content[0].text;
    return done(text);
  }, timeoutMs, what);
  return text;
}
