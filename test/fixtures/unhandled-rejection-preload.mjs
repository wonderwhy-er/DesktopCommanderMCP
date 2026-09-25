// Preloaded into the real server (node --import) by test-server-unhandled-rejection.js:
// once the test asks for it (DC_TEST_REJECT_AFTER_MS), creates a promise
// rejection nobody handles, like a library's detached cleanup promise.
// The delay counts from when the server's unhandledRejection handler is in
// place (src/index.ts adds it after loading the config), not from the start
// of the process: on a slow start the rejection would otherwise come first,
// and Node's default handling would end the server.
const delay = Number(process.env.DC_TEST_REJECT_AFTER_MS);
if (delay > 0) {
  const waitForHandler = setInterval(() => {
    if (process.listenerCount('unhandledRejection') === 0) return;
    clearInterval(waitForHandler);
    setTimeout(() => {
      process.stderr.write('fixture: rejecting now\n');
      Promise.reject(new Error('dc-test-rejection'));
    }, delay).unref();
  }, 10);
  waitForHandler.unref();
}
