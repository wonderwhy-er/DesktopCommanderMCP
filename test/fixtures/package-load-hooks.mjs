// Installed in the real server by test/helpers/server-modules.js with hookArgs()
// when a test holds a package back or makes it fail once:
// - DC_TEST_HOLD_PACKAGE: an import of it doesn't resolve until the file
//   DC_TEST_HOLD_RELEASE exists, so that package stays "still loading"
// - DC_TEST_FAIL_PACKAGE_ONCE: the first import of it fails (the file
//   DC_TEST_FAILED_MARKER records that it did); later ones load it
import fs from 'node:fs';

const HELD = process.env.DC_TEST_HOLD_PACKAGE;
const RELEASE = process.env.DC_TEST_HOLD_RELEASE;
const FAIL_ONCE = process.env.DC_TEST_FAIL_PACKAGE_ONCE;
const FAILED_MARKER = process.env.DC_TEST_FAILED_MARKER;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === HELD) {
    while (!fs.existsSync(RELEASE)) await new Promise((done) => setTimeout(done, 25));
  }
  if (specifier === FAIL_ONCE && !fs.existsSync(FAILED_MARKER)) {
    fs.writeFileSync(FAILED_MARKER, '');
    throw new Error(`${specifier} failed to load (test)`);
  }
  return nextResolve(specifier, context);
}
