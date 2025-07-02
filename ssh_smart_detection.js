// Option 2: SSH-Smart Command Detection
async function executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string): Promise<CommandExecutionResult> {
  
  // Detect SSH commands and handle specially
  const isSSHCommand = command.trim().startsWith('ssh ');
  const isInteractiveCommand = command.includes(' -i') || command.includes('python') || command.includes('mysql');
  
  if (isSSHCommand) {
    // Add SSH-friendly options automatically
    const sshEnhanced = command
      .replace(/^ssh /, 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -t ')
      .replace(/ -t -t/, ' -t'); // Avoid double -t
    
    console.log(`Enhanced SSH command: ${sshEnhanced}`);
    return executeEnhancedCommand(sshEnhanced, timeoutMs, shell);
  }
  
  if (isInteractiveCommand) {
    // Use PTY for interactive commands
    return executePTYCommand(command, timeoutMs);
  }
  
  // Regular execution for simple commands
  return executeRegularCommand(command, timeoutMs, shell);
}

// Enhanced SSH command execution
async function executeEnhancedCommand(command: string, timeoutMs: number, shell?: string) {
  const spawnOptions = { 
    shell: shell || true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TERM: 'xterm-256color',  // Better terminal support
      SSH_TTY: '/dev/tty'      // Help SSH detect TTY
    }
  };
  
  const process = spawn(command, [], spawnOptions);
  // ... rest of execution logic with immediate detection
}