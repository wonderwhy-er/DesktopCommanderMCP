# OS Detection and Tool Prompt Improvements

## Overview
This update adds operating system detection and provides OS-specific guidance in tool prompts to help the LLM provide more accurate and platform-appropriate responses.

## Changes Made

### 1. New System Information Utility (`src/utils/system-info.ts`)
- **OS Detection**: Detects Windows, macOS, Linux, and other Unix-like systems
- **Platform Info**: Provides platform name, default shell, path separators
- **Path Examples**: OS-specific absolute path examples
- **Guidance Generation**: Creates OS-specific guidance text for tool prompts

**Key Features:**
```typescript
interface SystemInfo {
    platform: string;        // raw os.platform() result
    platformName: string;    // human-readable name (Windows, macOS, Linux)
    defaultShell: string;    // OS-appropriate shell (powershell.exe, zsh, bash)
    pathSeparator: string;   // \ for Windows, / for Unix-like
    isWindows: boolean;
    isMacOS: boolean;
    isLinux: boolean;
    examplePaths: {
        home: string;        // C:\Users\username or /Users/username
        temp: string;        // C:\Temp or /tmp
        absolute: string;    // C:\path\to\file.txt or /path/to/file.txt
    };
}
```

### 2. Updated Tool Descriptions (`src/server.ts`)

#### PATH_GUIDANCE Enhancement
- **Before**: Generic advice about absolute paths for all platforms
- **After**: OS-specific path guidance with appropriate examples

#### start_process Tool
- **Before**: Generic Windows troubleshooting section regardless of OS
- **After**: Dynamic OS-specific guidance only when relevant
- **Windows**: Includes PowerShell vs CMD guidance, execution policy notes
- **Unix/Linux/macOS**: Standard Unix shell tool availability

#### get_config Tool
- **Added**: systemInfo field in configuration response
- **Purpose**: Provides OS context to LLM for better decision making

### 3. Configuration Enhancement (`src/tools/config.ts`)
- **Enhanced get_config()**: Now includes complete system information
- **Runtime Info**: Platform detection, shell info, path examples
- **Tool Context**: Helps LLM understand the operating environment

### 4. Process Tool Enhancement (`src/tools/improved-process-tools.ts`)
- **Shell Information**: start_process responses now include which shell was used
- **Example**: "Process started with PID 1234 (shell: powershell.exe)"

## Benefits

### For the LLM
1. **Reduced Guessing**: No longer needs to assume operating system
2. **Accurate Commands**: Can provide OS-appropriate shell commands
3. **Better Paths**: Uses correct path syntax for the platform
4. **Targeted Troubleshooting**: Windows-specific advice only on Windows

### For Users
1. **Fewer Errors**: Commands more likely to work on first try
2. **Appropriate Examples**: See relevant path formats and commands
3. **Better Guidance**: OS-specific troubleshooting and tips
4. **Clear Context**: Tool responses show what shell/environment is being used

## Examples of Improvements

### Windows Users
- **Before**: Generic "use absolute paths starting with /" advice
- **After**: "Use absolute paths starting with drive letter (e.g., C:\path\to\file.txt)"
- **Bonus**: PowerShell vs CMD troubleshooting only shown on Windows

### macOS/Linux Users  
- **Before**: Windows-specific PowerShell troubleshooting always shown
- **After**: Unix-appropriate guidance about standard shell tools
- **Bonus**: Correct default shell detection (zsh for macOS, bash for Linux)

### All Platforms
- **Shell Clarity**: Process responses show "shell: powershell.exe" or "shell: bash"
- **System Context**: get_config shows platform: "win32", platformName: "Windows"
- **Smart Defaults**: Appropriate default shell per OS

## Implementation Notes

### Backward Compatibility
- All existing tool functionality preserved
- Enhanced descriptions don't break existing workflows
- System info is additive to existing config

### Performance
- System detection happens once at startup
- No runtime overhead for OS detection
- Minimal memory footprint

### Extensibility
- Easy to add new OS-specific guidance
- Modular system-info utility can be extended
- Clear separation of concerns

## Future Enhancements

### Potential Additions
1. **Architecture Detection**: x64, ARM, etc.
2. **Version Detection**: Windows 10/11, macOS version, Linux distro
3. **Available Tools**: Detect if Node.js, Python, etc. are installed
4. **Environment Variables**: PATH, common directories
5. **Permissions**: User privileges, admin status

### Tool-Specific Improvements
1. **File Operations**: OS-specific file system notes
2. **Search Tools**: Platform-appropriate search commands  
3. **Network Tools**: OS-specific networking commands
4. **Development Tools**: Language-specific installation paths

This enhancement makes the tool much more intelligent about the operating environment, leading to better user experiences and fewer platform-related issues.