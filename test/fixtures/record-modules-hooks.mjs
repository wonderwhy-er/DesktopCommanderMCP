// Installed in the real server by test/helpers/server-modules.js with hookArgs()
// (helpers/module-hooks.js): writes every module an import resolves to
// DC_TEST_MODULE_LOG, in record-modules-preload.mjs's format.
import fs from 'node:fs';

const log = fs.openSync(process.env.DC_TEST_MODULE_LOG, 'a');

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  fs.writeSync(log, `${Date.now()} ${resolved.url} ${context.parentURL ?? ''}\n`);
  return resolved;
}
