// Option 3: Extend start_process with TTY options
export interface StartProcessOptions {
  command: string;
  timeout_ms: number;
  shell?: string;
  usePty?: boolean;        // NEW: Force PTY allocation  
  sshMode?: boolean;       // NEW: SSH-specific optimizations
  terminalSize?: {         // NEW: Terminal dimensions
    cols: number;
    rows: number;
  };
  env?: Record<string, string>; // NEW: Custom environment variables
}

// Usage examples:
start_process({
  command: "ssh user@droplet",
  timeout_ms: 15000,
  usePty: true,           // Enable full TTY emulation
  sshMode: true,          // Apply SSH-specific settings
  terminalSize: { cols: 80, rows: 24 }
});

start_process({
  command: "python3 -i", 
  timeout_ms: 8000,
  usePty: false           // Use pipes (current behavior)
});

// In terminal-manager.ts:
async executeCommand(options: StartProcessOptions): Promise<CommandExecutionResult> {
  const { command, timeout_ms, usePty = false, sshMode = false } = options;
  
  if (usePty) {
    return executePTYCommand(options);
  } else {
    return executeRegularCommand(options);
  }
}

async function executePTYCommand(options: StartProcessOptions) {
  const pty = require('node-pty');
  
  const ptyProcess = pty.spawn('bash', ['-c', options.command], {
    name: 'xterm-color',
    cols: options.terminalSize?.cols || 80,
    rows: options.terminalSize?.rows || 24,
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...options.env,
      TERM: 'xterm-256color'
    }
  });
  
  // Immediate detection still works with PTY data
  ptyProcess.onData((data) => {
    output += data;
    
    // Same immediate detection logic
    if (quickPromptPatterns.test(data)) {
      resolveOnce({
        pid: ptyProcess.pid,
        output,
        isBlocked: true
      });
    }
  });
  
  return ptyProcess;
}