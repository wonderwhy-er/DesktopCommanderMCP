// Preloaded into the real server (node --import) by test/helpers/server-modules.js:
// writes every module the server resolves, through import or require, to
// DC_TEST_MODULE_LOG as it happens, one "<Date.now()> <url> <parent url>" line each.
// module.registerHooks() sees both, but Node has it only from 22.15. Before
// that, imports are recorded by record-modules-hooks.mjs through
// module.register(), and requires through Module._resolveFilename (which a
// require('node:...') of a built-in skips; the tests leave built-ins out).
import fs from 'node:fs';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';

const log = fs.openSync(process.env.DC_TEST_MODULE_LOG, 'a');
const record = (url, parentURL) => fs.writeSync(log, `${Date.now()} ${url} ${parentURL ?? ''}\n`);

if (Module.registerHooks) {
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      record(resolved.url, context.parentURL);
      return resolved;
    },
  });
} else {
  Module.register('./record-modules-hooks.mjs', import.meta.url);
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    const filename = resolveFilename.call(this, request, parent, ...rest);
    const url = Module.isBuiltin(filename) ? `node:${filename.replace(/^node:/, '')}` : pathToFileURL(filename).href;
    record(url, parent?.filename && pathToFileURL(parent.filename).href);
    return filename;
  };
}
