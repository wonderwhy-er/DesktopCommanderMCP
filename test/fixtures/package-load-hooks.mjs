// Installed in the real server by test/helpers/server-modules.js with hookArgs()
// when a test holds a package back or makes it fail once:
// - DC_TEST_HOLD_PACKAGE: an import() of it doesn't resolve until the file
//   DC_TEST_HOLD_RELEASE exists, so that package stays "still loading"
//   (a require() can't be held: package-load-preload.mjs fails it instead)
// - DC_TEST_FAIL_PACKAGE_ONCE: the first ES module of the server's own copy of
//   it (node_modules/<package> in its working folder) that loads fails, as a
//   broken package does (DC_TEST_FAILED_MARKER records that it did); a
//   CommonJS one fails in package-load-preload.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HELD = process.env.DC_TEST_HOLD_PACKAGE;
const RELEASE = process.env.DC_TEST_HOLD_RELEASE;
const FAIL_ONCE = process.env.DC_TEST_FAIL_PACKAGE_ONCE;
const FAILED_MARKER = process.env.DC_TEST_FAILED_MARKER;
// Its real path, as Node names its files (node_modules can be a link)
const PACKAGE_URL = FAIL_ONCE && `${pathToFileURL(fs.realpathSync(path.join(process.cwd(), 'node_modules', FAIL_ONCE))).href}/`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === HELD) {
    while (!fs.existsSync(RELEASE)) await new Promise((done) => setTimeout(done, 25));
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (FAIL_ONCE && result.format === 'module' && url.startsWith(PACKAGE_URL) && !fs.existsSync(FAILED_MARKER)) {
    fs.writeFileSync(FAILED_MARKER, '');
    throw new Error(`${FAIL_ONCE} failed to load (test)`);
  }
  return result;
}
