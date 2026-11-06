/**
 * A user-configured four-thread pool must still have room for a healthy read
 * while one folder's native lookups are held. Reuse the real stalled-read
 * fixture and every assertion; only the server's startup pool setting differs.
 */
import runReadBeside from './test-read-beside-stalled-path.js';
import { runIfMain } from './helpers/run-if-main.js';

/** Exercise the existing native-stall scenario with a four-thread server pool. */
export default async function runTests() {
  console.log('Server startup UV_THREADPOOL_SIZE=4; reuse the native stalled-read regression');
  return runReadBeside({ threadpoolSize: 4 });
}

runIfMain(import.meta.url, runTests);
