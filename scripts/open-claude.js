#!/usr/bin/env node

import { exec } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';

function findClaudeOnWindows() {
  const basePaths = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)']
  ].filter(Boolean);

  const claudeExecutables = [
    'AnthropicClaude\\claude.exe',
    'Claude\\Claude.exe',
    'Claude Desktop\\Claude.exe',
    'Programs\\Claude\\Claude.exe'
  ];

  for (const basePath of basePaths) {
    for (const claudeExe of claudeExecutables) {
      const fullPath = join(basePath, claudeExe);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

function openClaude() {
  const currentPlatform = platform();
  let command;

  switch (currentPlatform) {
    case 'darwin': // macOS
      command = 'open -n /Applications/Claude.app';
      break;
    
    case 'win32': // Windows
      const claudePath = findClaudeOnWindows();
      if (claudePath) {
        command = `start "" "${claudePath}"`;
        console.log(`Found Claude at: ${claudePath}`);
      } else {
        console.error('Claude Desktop not found in common installation locations.');
        console.log('Searched in:');
        console.log('- %LOCALAPPDATA%\\AnthropicClaude\\claude.exe');
        console.log('- %LOCALAPPDATA%\\Claude\\Claude.exe');
        console.log('- %APPDATA%\\Claude\\Claude.exe');
        console.log('- %PROGRAMFILES%\\Claude\\Claude.exe');
        console.log('- %PROGRAMFILES(X86)%\\Claude\\Claude.exe');
        console.log('\\nPlease install Claude Desktop from: https://claude.ai/download');
        process.exit(1);
      }
      break;
    
    case 'linux': // Linux
      // Try common Linux installation methods
      const linuxCommands = [
        'claude',
        'flatpak run com.anthropic.Claude',
        'snap run claude',
        '/opt/Claude/claude',
        '/usr/bin/claude',
        '/usr/local/bin/claude'
      ];
      
      // Try to find any working command
      command = linuxCommands.map(cmd => `which ${cmd.split(' ')[0]} > /dev/null && ${cmd}`).join(' || ') + 
                ' || echo "Claude not found. Please install Claude Desktop."';
      break;
    
    default:
      console.error(`Unsupported platform: ${currentPlatform}`);
      console.log('Supported platforms: macOS (darwin), Windows (win32), Linux');
      process.exit(1);
  }

  console.log(`Opening Claude on ${currentPlatform}...`);

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error opening Claude: ${error.message}`);
      return;
    }
    
    if (stderr) {
      console.error(`Warning: ${stderr}`);
    }
    
    if (stdout) {
      console.log(stdout);
    }
    
    console.log('Claude should be opening...');
  });
}

openClaude();
