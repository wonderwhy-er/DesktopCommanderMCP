// Preloaded into the real server (node --import) by test/helpers/server-modules.js,
// which records the server's imports with record-modules-hooks.mjs: writes every
// module the server resolves through require to DC_TEST_MODULE_LOG as it happens,
// one "<Date.now()> <url> <parent url>" line each, the hooks' format. (A
// require('node:...') of a built-in skips Module._resolveFilename; the tests
// leave built-ins out.)
import fs from 'node:fs';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';

const log = fs.openSync(process.env.DC_TEST_MODULE_LOG, 'a');
const record = (url, parentURL) => fs.writeSync(log, `${Date.now()} ${url} ${parentURL ?? ''}\n`);

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const filename = resolveFilename.call(this, request, parent, ...rest);
  const url = Module.isBuiltin(filename) ? `node:${filename.replace(/^node:/, '')}` : pathToFileURL(filename).href;
  record(url, parent?.filename && pathToFileURL(parent.filename).href);
  return filename;
};
