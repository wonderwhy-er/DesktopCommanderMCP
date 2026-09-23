import { spawn } from 'child_process';

/**
 * Keep `filePath` open in another process for `ms` milliseconds, the way a
 * virus scanner, indexer or another reader does. On Windows the handle allows
 * others to read but not to delete or rename the file (FileShare.Read), so a
 * rename fails with EPERM/EBUSY until it is closed; on macOS/Linux an open
 * file never blocks a rename.
 * Resolves with the child process once the file is open.
 */
export function holdFileOpen(filePath, ms) {
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-Command',
        `$f = [IO.File]::Open('${filePath}', 'Open', 'Read', 'Read'); Write-Output locked; Start-Sleep -Milliseconds ${ms}; $f.Close()`])
    : spawn(process.execPath, ['-e',
        `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(filePath)}, 'r'); console.log('locked'); setTimeout(() => fs.closeSync(fd), ${ms});`]);

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('locked')) resolve(child);
    });
  });
}
