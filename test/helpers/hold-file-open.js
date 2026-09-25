import { spawn } from 'child_process';
import { psQuote } from './powershell.js';

/**
 * Keep `filePath` open in another process for `ms` milliseconds, the way a
 * virus scanner, indexer or another reader does. On Windows `share` is what
 * the handle still allows others: 'Read' (the default) lets them read but not
 * delete or rename the file, so a rename fails with EPERM/EBUSY until it is
 * closed; 'None' lets them do nothing, not even read. On macOS/Linux an open
 * file never blocks a rename or a read.
 * Resolves with the child process once the file is open; rejects if the child
 * can't start or exits before it has the file open (it can't open the file).
 */
export function holdFileOpen(filePath, ms, share = 'Read') {
  // PowerShell goes on to the next statement after a failed open; 'Stop' ends it there
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-Command',
        `$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open(${psQuote(filePath)}, 'Open', 'Read', ${psQuote(share)}); Write-Output locked; Start-Sleep -Milliseconds ${ms}; $f.Close()`])
    : spawn(process.execPath, ['-e',
        `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(filePath)}, 'r'); console.log('locked'); setTimeout(() => fs.closeSync(fd), ${ms});`]);

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      reject(new Error(`the process holding ${filePath} exited before it had the file open (${signal ?? `exit code ${code}`})`));
    });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('locked')) resolve(child);
    });
  });
}
