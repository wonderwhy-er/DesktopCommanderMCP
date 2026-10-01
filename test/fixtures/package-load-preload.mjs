// Preloaded into the real server (node --import) by test/helpers/server-modules.js
// when a test makes a package fail to load once: the first require() of
// DC_TEST_FAIL_PACKAGE_ONCE (or of a file in it) throws, as package-load-hooks.mjs
// does for an import; DC_TEST_FAILED_MARKER records that it did.
import fs from 'node:fs';
import Module from 'node:module';

const FAIL_ONCE = process.env.DC_TEST_FAIL_PACKAGE_ONCE;
const FAILED_MARKER = process.env.DC_TEST_FAILED_MARKER;

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if ((request === FAIL_ONCE || request.startsWith(`${FAIL_ONCE}/`)) && !fs.existsSync(FAILED_MARKER)) {
    fs.writeFileSync(FAILED_MARKER, '');
    throw new Error(`${FAIL_ONCE} failed to load (test)`);
  }
  return resolveFilename.call(this, request, ...rest);
};
