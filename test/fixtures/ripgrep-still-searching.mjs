// Stands in for ripgrep in test-search-stopped-not-failed.js (see
// ripgrep-still-searching-preload.mjs): it reports a folder it may not read, as
// ripgrep does on a big tree, and goes on searching; it never ends on its own.
const denied = process.platform === 'win32' ? 'Access is denied. (os error 5)' : 'Permission denied (os error 13)';
process.stderr.write(`rg: private: ${denied}\n`);
setInterval(() => {}, 60_000);
