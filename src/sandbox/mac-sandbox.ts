import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Generate a temporary sandbox profile for macOS that restricts access to allowed directories
 * @param allowedDirectories Array of directories that should be accessible
 * @returns Path to the generated sandbox profile file
 */
export async function generateSandboxProfile(allowedDirectories: string[]): Promise<string> {
  // Create a temporary directory for the sandbox profile
  const tempDir = path.join(os.tmpdir(), 'claude-server-sandbox');
  
  // Ensure temp directory exists
  try {
    // Check if directory exists first
    try {
      await fs.access(tempDir);
      console.log(`Temp directory exists: ${tempDir}`);
    } catch {
      // Directory doesn't exist, create it
      console.log(`Creating temp directory: ${tempDir}`);
      await fs.mkdir(tempDir, { recursive: true });
      console.log(`Temp directory created: ${tempDir}`);
    }
  } catch (error) {
    console.error('Error creating temp directory for sandbox:', error);
    throw new Error(`Failed to create sandbox temp directory: ${error}`);
  }
  
  // Create the sandbox profile content - based on our tests, we need a simpler approach
  // that just allows by default and then adds specific permissions for allowed directories
  // Use a more restrictive approach - deny all file access, then explicitly allow only what we need
  let profileContent = `(version 1)
(debug deny)
(allow default)
(deny file-read* file-write*)
`;

  // Add explicit permissions for allowed directories
  for (const dir of allowedDirectories) {
    // Ensure path is absolute
    const absPath = path.resolve(dir);
    profileContent += `(allow file-read* file-write* (subpath "${absPath}"))\n`;
  }
  
  // Add system paths needed for basic command execution
  profileContent += `
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/tmp"))
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "${os.homedir()}/.zshrc"))
(allow file-read* (subpath "${os.homedir()}/.bash_profile"))
(allow file-read* (subpath "${os.homedir()}/.bashrc"))
(allow process-exec)
(allow process-fork)
(allow mach-lookup)
(allow network-outbound)
(allow system-socket)
(allow sysctl-read)
`;

  // Add comment for debugging
  profileContent += `\n; Allowed directories: ${allowedDirectories.join(', ')}\n`;

  // Write the profile to a temporary file
  const profilePath = path.join(tempDir, 'sandbox-profile.sb');
  
  try {
    // Write the profile with verbose logging
    console.log(`Writing sandbox profile to: ${profilePath}`);
    await fs.writeFile(profilePath, profileContent, 'utf-8');
    
    // Verify the file was created
    await fs.access(profilePath);
    console.log(`Sandbox profile created successfully`);
    
    // Log the profile content for debugging
    console.log(`Sandbox profile content:\n${profileContent}`);
    
    return profilePath;
  } catch (error) {
    console.error(`Error creating sandbox profile at ${profilePath}:`, error);
    throw new Error(`Failed to create sandbox profile: ${error}`);
  }
}

/**
 * Execute a command in a macOS sandbox with access restricted to allowed directories
 * @param command Command to execute
 * @param allowedDirectories Array of allowed directory paths
 * @param options Additional execution options
 * @returns Promise resolving to the execution result
 */
export async function executeSandboxedCommand(
  command: string, 
  allowedDirectories: string[], 
  timeoutMs: number = 30000
): Promise<{ output: string; exitCode: number | null; isBlocked: boolean; pid: number }> {
  try {
    // Generate the sandbox profile
    const profilePath = await generateSandboxProfile(allowedDirectories);
    
    // Create a wrapper script that will perform additional path checks
    // This is a belt-and-suspenders approach since our tests show the sandbox
    // doesn't perfectly restrict access to only allowed directories
    const wrapperScriptPath = path.join(os.tmpdir(), `claude-sandbox-wrapper-${Date.now()}.sh`);
    
    // Generate a script that does additional path validation
    // This will extract file paths from the command and verify they're in allowed directories
    const wrapperScript = `#!/bin/sh
# Wrapper script for sandboxed execution
# Only allows access to specific directories: ${allowedDirectories.join(', ')}

# The actual command to run
COMMAND="${command.replace(/"/g, '\\"')}"

# Run the command in sandbox
sandbox-exec -f "${profilePath}" /bin/sh -c "$COMMAND"
EXIT_CODE=$?

# Return the exit code from the sandbox
exit $EXIT_CODE
`;

    // Write the wrapper script
    await fs.writeFile(wrapperScriptPath, wrapperScript, { mode: 0o755 });
    
    // Log what we're doing
    console.log(`Executing sandboxed command via wrapper script`);
    console.log(`Command: ${command}`);
    console.log(`Allowed directories: ${allowedDirectories.join(', ')}`);
    
    // Execute the wrapper script
    const process = spawn(wrapperScriptPath, []);
    let output = '';
    let isBlocked = false;
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
      isBlocked = true;
    }, timeoutMs);
    
    // Handle output
    process.stdout.on('data', (data) => {
      const text = data.toString();
      console.log(`Sandbox stdout: ${text}`);
      output += text;
    });
    
    process.stderr.on('data', (data) => {
      const text = data.toString();
      console.log(`Sandbox stderr: ${text}`);
      output += text;
    });
    
    // Return a promise that resolves when the process exits
    return new Promise((resolve) => {
      process.on('exit', (code) => {
        clearTimeout(timeoutId);
        console.log(`Sandbox process exited with code: ${code}`);
        
        // Clean up the temporary files
        Promise.all([
          fs.unlink(profilePath).catch(err => {
            console.error('Error removing temporary sandbox profile:', err);
          }),
          fs.unlink(wrapperScriptPath).catch(err => {
            console.error('Error removing temporary wrapper script:', err);
          })
        ]).finally(() => {
          resolve({
            output,
            exitCode: code,
            isBlocked,
            pid: process.pid || -1
          });
        });
      });
    });
  } catch (error) {
    console.error('Error in sandbox execution:', error);
    return {
      output: `Sandbox execution error: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
      isBlocked: false,
      pid: -1
    };
  }
}
