#!/usr/bin/env node

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import { copyFileSync, existsSync, chmodSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Determine platform-specific settings
const isWindows = platform() === 'win32';
const isMacOS = platform() === 'darwin';
const nodeBinary = isWindows ? 'node.exe' : 'node';
const executableExt = isWindows ? '.exe' : '';

// Define paths
const NODE_EXECUTABLE = join(rootDir, `bin/${nodeBinary}`);
const DESKTOP_COMMANDER_OUTPUT = join(rootDir, `desktop-commander${executableExt}`);
const SETUP_OUTPUT = join(rootDir, `setup${executableExt}`);

// Function to run commands
async function runCommand(command, args, cwd = rootDir) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command} ${args.join(' ')}`);
    
    const proc = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: true
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
  });
}

// Main function to build SEA
async function buildSEA() {
  try {
    console.log('Building DesktopCommanderMCP with Node.js SEA...');
    
    // Step 1: Install esbuild if not already installed
    console.log('Installing dependencies...');
    await runCommand('npm', ['install', '--save-dev', 'esbuild', 'postject']);
    
    // Step 2: Bundle the application with esbuild
    console.log('Bundling application...');
    await runCommand('node', ['scripts/bundle.js']);
    
    // Step 3: Create the SEA preparation blob
    console.log('Creating SEA preparation blob...');
    await runCommand('npx', ['-y', 'sea-prep', 'sea-config.json']);
    await runCommand('npx', ['-y', 'sea-prep', 'sea-setup-config.json']);
    
    // Step 4: Copy the Node.js binary
    console.log('Copying Node.js binary...');
    // Create bin directory if it doesn't exist
    if (!existsSync(join(rootDir, 'bin'))) {
      await runCommand('mkdir', ['-p', join(rootDir, 'bin')]);
    }
    
    // Use the current Node.js executable
    const currentNodePath = process.execPath;
    copyFileSync(currentNodePath, NODE_EXECUTABLE);
    chmodSync(NODE_EXECUTABLE, 0o755); // Make executable
    
    // Step 5: Inject the blob into the Node.js binary
    console.log('Injecting blob into binary for desktop-commander...');
    
    // Command differs based on platform
    if (isMacOS) {
      await runCommand('npx', [
        'postject', 
        NODE_EXECUTABLE, 
        'NODE_SEA_BLOB', 
        'desktop-commander-sea.blob', 
        '--sentinel-fuse', 
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
        '--macho-segment-name',
        'NODE_SEA'
      ]);
    } else {
      await runCommand('npx', [
        'postject', 
        NODE_EXECUTABLE, 
        'NODE_SEA_BLOB', 
        'desktop-commander-sea.blob', 
        '--sentinel-fuse', 
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
      ]);
    }
    
    // Copy the resulting binary to the final executable
    copyFileSync(NODE_EXECUTABLE, DESKTOP_COMMANDER_OUTPUT);
    chmodSync(DESKTOP_COMMANDER_OUTPUT, 0o755); // Make executable
    
    // Create setup executable similarly
    console.log('Injecting blob into binary for setup...');
    
    // Reset NODE_EXECUTABLE (use fresh copy)
    copyFileSync(currentNodePath, NODE_EXECUTABLE);
    chmodSync(NODE_EXECUTABLE, 0o755); // Make executable
    
    // Inject setup blob
    if (isMacOS) {
      await runCommand('npx', [
        'postject', 
        NODE_EXECUTABLE, 
        'NODE_SEA_BLOB', 
        'setup-sea.blob', 
        '--sentinel-fuse', 
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
        '--macho-segment-name',
        'NODE_SEA'
      ]);
    } else {
      await runCommand('npx', [
        'postject', 
        NODE_EXECUTABLE, 
        'NODE_SEA_BLOB', 
        'setup-sea.blob', 
        '--sentinel-fuse', 
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
      ]);
    }
    
    // Copy the resulting binary to the final executable
    copyFileSync(NODE_EXECUTABLE, SETUP_OUTPUT);
    chmodSync(SETUP_OUTPUT, 0o755); // Make executable
    
    console.log('Build complete!');
    console.log(`Executables created:`);
    console.log(`- ${DESKTOP_COMMANDER_OUTPUT}`);
    console.log(`- ${SETUP_OUTPUT}`);
    
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

// Run the build process
buildSEA();
