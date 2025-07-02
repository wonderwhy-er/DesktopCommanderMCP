// Option 1: Add PTY Support to Terminal Manager
import { spawn } from 'child_process';
import * as pty from 'node-pty'; // Would need to install: npm install node-pty

// Enhanced spawn options with PTY support
const spawnOptions = { 
  shell: shellToUse,
  stdio: usePty ? undefined : ['pipe', 'pipe', 'pipe'], // Standard for non-PTY
};

// For PTY-dependent commands (SSH, interactive sessions)
if (usePty) {
  const ptyProcess = pty.spawn(command, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.cwd(),
    env: process.env
  });
  
  // PTY provides full terminal emulation
  ptyProcess.onData((data) => {
    output += data;
    session.lastOutput += data;
    
    // Immediate detection still works with PTY
    if (quickPromptPatterns.test(data)) {
      // ... immediate detection logic
    }
  });
  
  return ptyProcess;
} else {
  // Use regular spawn for simple commands
  const process = spawn(command, [], spawnOptions);
  // ... existing logic
}