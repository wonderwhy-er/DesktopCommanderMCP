// Module hooks for the search tests (installed with hookArgs() from
// helpers/module-hooks.js): the search manager's ripgrep is a stand-in. Only
// the search manager's child_process changes: its spawn() runs
// - the stand-in ripgrep-still-searching.mjs, a ripgrep that has met a folder
//   it may not read and is still searching (test-search-stopped-not-failed.js);
// - or, with DC_TEST_RIPGREP_SCRIPT set (JSON), the scripted ripgrep of
//   ripgrep-scripted.mjs (test-search-outcome.js).
import { fileURLToPath } from 'node:url';

const standIn = fileURLToPath(new URL('./ripgrep-still-searching.mjs', import.meta.url));
const scripted = new URL('./ripgrep-scripted.mjs', import.meta.url).href;
const childProcess = `
import childProcess from 'node:child_process';
import { scriptedRipgrep } from ${JSON.stringify(scripted)};
export * from 'node:child_process';
export const spawn = (command, args, options) => process.env.DC_TEST_RIPGREP_SCRIPT
  ? scriptedRipgrep(JSON.parse(process.env.DC_TEST_RIPGREP_SCRIPT))
  : childProcess.spawn(process.execPath, [${JSON.stringify(standIn)}], options);`;

export async function resolve(specifier, context, nextResolve) {
  if ((specifier === 'child_process' || specifier === 'node:child_process') && context.parentURL?.endsWith('/dist/search-manager.js')) {
    return { url: `data:text/javascript,${encodeURIComponent(childProcess)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
