// Module hooks for test-search-without-ripgrep.js (installed with hookArgs()
// from helpers/module-hooks.js): the bundled ripgrep is there but cannot be
// started - as with a corrupt or wrong-platform download - so Desktop
// Commander's searches fail to start it. @vscode/ripgrep resolves to a
// stand-in whose rgPath is DC_TEST_UNUSABLE_RIPGREP, a directory.
const standIn = `export const rgPath = ${JSON.stringify(process.env.DC_TEST_UNUSABLE_RIPGREP)};`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@vscode/ripgrep') {
    return { url: `data:text/javascript,${encodeURIComponent(standIn)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
