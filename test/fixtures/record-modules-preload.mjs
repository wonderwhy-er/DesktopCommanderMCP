// Preloaded into the real server (node --import) by test/helpers/server-modules.js:
// writes every module the server resolves, through import or require, to
// DC_TEST_MODULE_LOG as it happens, one "<Date.now()> <url> <parent url>" line each.
import fs from 'node:fs';
import { registerHooks } from 'node:module';

const log = fs.openSync(process.env.DC_TEST_MODULE_LOG, 'a');

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    fs.writeSync(log, `${Date.now()} ${resolved.url} ${context.parentURL ?? ''}\n`);
    return resolved;
  },
});
