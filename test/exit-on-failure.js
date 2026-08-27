export function runTest(testFn) {
  Promise.resolve()
    .then(testFn)
    .then((success) => {
      if (success === false) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error('❌ Unhandled error:', error);
      process.exitCode = 1;
    });
}
