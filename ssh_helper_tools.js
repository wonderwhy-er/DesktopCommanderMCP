// Option 4: Add SSH-specific helper commands
// New tools in improved-process-tools.ts

/**
 * SSH connection with automatic TTY and authentication handling
 */
export async function sshConnect(args: {
  host: string;
  user?: string;
  keyFile?: string;
  password?: string;
  timeout_ms?: number;
}): Promise<ServerResult> {
  
  const { host, user = 'root', keyFile, password, timeout_ms = 20000 } = args;
  
  let sshCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -t`;
  
  if (keyFile) {
    sshCommand += ` -i ${keyFile}`;
  }
  
  if (user && host) {
    sshCommand += ` ${user}@${host}`;
  }
  
  // Use PTY for SSH connections
  const result = await terminalManager.executeCommand(sshCommand, timeout_ms, undefined, {
    usePty: true,
    sshMode: true
  });
  
  return {
    content: [{
      type: "text",
      text: `SSH connection established to ${user}@${host}\nPID: ${result.pid}\n${result.output}`
    }]
  };
}

/**
 * Execute command on remote host via SSH
 */
export async function sshExecute(args: {
  host: string;
  user?: string;
  command: string;
  keyFile?: string;
  timeout_ms?: number;
}): Promise<ServerResult> {
  
  const { host, user = 'root', command, keyFile, timeout_ms = 15000 } = args;
  
  let sshCommand = `ssh -o StrictHostKeyChecking=no -o BatchMode=yes`;
  
  if (keyFile) {
    sshCommand += ` -i ${keyFile}`;
  }
  
  sshCommand += ` ${user}@${host} '${command}'`;
  
  const result = await terminalManager.executeCommand(sshCommand, timeout_ms);
  
  return {
    content: [{
      type: "text", 
      text: `Remote execution on ${user}@${host}:\n${result.output}`
    }]
  };
}

// Usage examples:
// ssh_connect({ host: "droplet.digitalocean.com", user: "root", keyFile: "~/.ssh/id_rsa" })
// ssh_execute({ host: "droplet.com", command: "python3 -c 'print(2+3)'" })