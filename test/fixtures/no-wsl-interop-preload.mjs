// Preloaded into every test process on Linux: by the test-home hook (test/helpers/test-home.js) in a test
// file's own process, and through NODE_OPTIONS (createTestEnv() in test/helpers/test-env.js) in the processes
// it starts. WSL's interop entry in binfmt_misc, which lets Linux run Windows programs, then isn't
// there for the tests, so in WSL command names are read as on Linux, as on any other Linux machine. A test of
// WSL's reading stands in for the entry itself (test-command-check-names.js).
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';

const existsSync = fs.existsSync;
fs.existsSync = (file) => (String(file).startsWith('/proc/sys/fs/binfmt_misc/WSLInterop') ? false : existsSync(file));
syncBuiltinESMExports();
