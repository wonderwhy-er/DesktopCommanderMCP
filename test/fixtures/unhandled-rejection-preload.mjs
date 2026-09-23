// Preloaded into the real server (node --import) by test-server-unhandled-rejection.js:
// once the test asks for it (DC_TEST_REJECT_AFTER_MS), creates a promise
// rejection nobody handles, like a library's detached cleanup promise.
const delay = Number(process.env.DC_TEST_REJECT_AFTER_MS);
if (delay > 0) {
  setTimeout(() => {
    process.stderr.write('fixture: rejecting now\n');
    Promise.reject(new Error('dc-test-rejection'));
  }, delay).unref();
}
