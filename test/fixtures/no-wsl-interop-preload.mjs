// Preloaded into every test process on Linux (node --import, through NODE_OPTIONS) by createTestEnv() in
// test/helpers/test-env.js: WSL's interop entry in binfmt_misc, which lets Linux run Windows programs, isn't
// there for the tests, so in WSL command names are read as on Linux, as on any other Linux machine. A test of
// WSL's reading stands in for the entry itself (test-command-check-names.js).
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';

const existsSync = fs.existsSync;
fs.existsSync = (file) => (String(file).startsWith('/proc/sys/fs/binfmt_misc/WSLInterop') ? false : existsSync(file));
syncBuiltinESMExports();
