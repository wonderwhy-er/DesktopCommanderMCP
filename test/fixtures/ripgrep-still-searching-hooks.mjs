// Module hooks for test-search-stopped-not-failed.js (installed with
// hookArgs() from helpers/module-hooks.js): the search manager's ripgrep is
// the stand-in ripgrep-still-searching.mjs, a ripgrep that has met a folder it
// may not read and is still searching. Only the search manager's child_process
// changes: its spawn() runs the stand-in.
import { fileURLToPath } from 'node:url';

const standIn = fileURLToPath(new URL('./ripgrep-still-searching.mjs', import.meta.url));
const childProcess = `
import childProcess from 'node:child_process';
export * from 'node:child_process';
export const spawn = (command, args, options) => childProcess.spawn(process.execPath, [${JSON.stringify(standIn)}], options);`;

export async function resolve(specifier, context, nextResolve) {
  if ((specifier === 'child_process' || specifier === 'node:child_process') && context.parentURL?.endsWith('/dist/search-manager.js')) {
    return { url: `data:text/javascript,${encodeURIComponent(childProcess)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
