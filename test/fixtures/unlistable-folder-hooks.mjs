// Module hooks for test-search-outcome.js (installed with hookArgs() from
// helpers/module-hooks.js): the search manager can't list a folder named
// "unlistable". Its fs/promises readdir() fails there with the error code in
// DC_TEST_UNLISTABLE_CODE (EACCES, EIO...), as for a folder the Excel/DOCX
// search may not or cannot read. ripgrep is the real one and reads it.
const fsPromises = `
import fsp from 'node:fs/promises';
import path from 'node:path';
export * from 'node:fs/promises';
const code = process.env.DC_TEST_UNLISTABLE_CODE;
export const readdir = async (dir, options) => {
  if (path.basename(String(dir)) === 'unlistable') throw Object.assign(new Error(code + ': cannot list ' + dir), { code });
  return fsp.readdir(dir, options);
};
export default { ...fsp, readdir };`;

export async function resolve(specifier, context, nextResolve) {
  if ((specifier === 'fs/promises' || specifier === 'node:fs/promises') && context.parentURL?.endsWith('/dist/search-manager.js')) {
    return { url: `data:text/javascript,${encodeURIComponent(fsPromises)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
