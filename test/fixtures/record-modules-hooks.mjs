// Registered by record-modules-preload.mjs with module.register() on Node
// before 22.15. Runs on Node's loader thread and writes every module an import
// resolves to DC_TEST_MODULE_LOG, in the preload's format.
import fs from 'node:fs';

const log = fs.openSync(process.env.DC_TEST_MODULE_LOG, 'a');

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  fs.writeSync(log, `${Date.now()} ${resolved.url} ${context.parentURL ?? ''}\n`);
  return resolved;
}
