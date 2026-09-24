// Preloaded (node --import) by test-search-without-ripgrep.js: the bundled
// ripgrep is there but cannot be started - as with a corrupt or wrong-platform
// download - so Desktop Commander's searches fail to start it. @vscode/ripgrep
// resolves to a stand-in whose rgPath is DC_TEST_UNUSABLE_RIPGREP, a directory.
import { register } from 'node:module';

const standIn = `export const rgPath = ${JSON.stringify(process.env.DC_TEST_UNUSABLE_RIPGREP)};`;
const hooks = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vscode/ripgrep') {
    return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(standIn)}`)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
