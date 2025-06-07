import os from 'os';

export interface SystemInfo {
    platform: string;
    platformName: string;
    defaultShell: string;
    pathSeparator: string;
    isWindows: boolean;
    isMacOS: boolean;
    isLinux: boolean;
    examplePaths: {
        home: string;
        temp: string;
        absolute: string;
    };
}

/**
 * Get comprehensive system information for tool prompts
 */
export function getSystemInfo(): SystemInfo {
    const platform = os.platform();
    const isWindows = platform === 'win32';
    const isMacOS = platform === 'darwin';
    const isLinux = platform === 'linux';
    
    let platformName: string;
    let defaultShell: string;
    let pathSeparator: string;
    let examplePaths: SystemInfo['examplePaths'];
    
    if (isWindows) {
        platformName = 'Windows';
        defaultShell = 'powershell.exe';
        pathSeparator = '\\';
        examplePaths = {
            home: 'C:\\Users\\username',
            temp: 'C:\\Temp',
            absolute: 'C:\\path\\to\\file.txt'
        };
    } else if (isMacOS) {
        platformName = 'macOS';
        defaultShell = 'zsh';
        pathSeparator = '/';
        examplePaths = {
            home: '/Users/username',
            temp: '/tmp',
            absolute: '/path/to/file.txt'
        };
    } else if (isLinux) {
        platformName = 'Linux';
        defaultShell = 'bash';
        pathSeparator = '/';
        examplePaths = {
            home: '/home/username',
            temp: '/tmp',
            absolute: '/path/to/file.txt'
        };
    } else {
        // Fallback for other Unix-like systems
        platformName = 'Unix';
        defaultShell = 'bash';
        pathSeparator = '/';
        examplePaths = {
            home: '/home/username',
            temp: '/tmp',
            absolute: '/path/to/file.txt'
        };
    }
    
    return {
        platform,
        platformName,
        defaultShell,
        pathSeparator,
        isWindows,
        isMacOS,
        isLinux,
        examplePaths
    };
}

/**
 * Generate OS-specific guidance for tool prompts
 */
export function getOSSpecificGuidance(systemInfo: SystemInfo): string {
    const { platformName, defaultShell, isWindows } = systemInfo;
    
    let guidance = `Running on ${platformName}. Default shell: ${defaultShell}.`;
    
    if (isWindows) {
        guidance += `
        
WINDOWS-SPECIFIC TROUBLESHOOTING:
- If Node.js/Python commands fail with "not recognized" errors:
  * Try different shells: specify shell parameter as "cmd" or "powershell.exe"
  * PowerShell may have execution policy restrictions for some tools
  * CMD typically has better compatibility with development tools
  * Use set_config_value to change defaultShell if needed
- Windows services and processes use different commands (Get-Process vs ps)
- Package managers: choco, winget, scoop instead of apt/brew
- Environment variables: $env:VAR instead of $VAR
- File permissions work differently than Unix systems`;
    } else if (systemInfo.isMacOS) {
        guidance += `
        
MACOS-SPECIFIC NOTES:
- Package manager: brew (Homebrew) is commonly used
- Python 3 might be 'python3' command, not 'python'
- Some GNU tools have different names (e.g., gsed instead of sed)
- System Integrity Protection (SIP) may block certain operations
- Use 'open' command to open files/applications from terminal`;
    } else {
        guidance += `
        
LINUX-SPECIFIC NOTES:
- Package managers vary by distro: apt, yum, dnf, pacman, zypper
- Python 3 might be 'python3' command, not 'python'
- Standard Unix shell tools available (grep, awk, sed, etc.)
- File permissions and ownership important for many operations
- Systemd services common on modern distributions`;
    }
    
    return guidance;
}

/**
 * Get common development tool guidance based on OS
 */
export function getDevelopmentToolGuidance(systemInfo: SystemInfo): string {
    const { isWindows, isMacOS, isLinux, platformName } = systemInfo;
    
    if (isWindows) {
        return `
COMMON WINDOWS DEVELOPMENT TOOLS:
- Node.js: Usually installed globally, accessible from any shell
- Python: May be 'python' or 'py' command, check both
- Git: Git Bash provides Unix-like environment
- WSL: Windows Subsystem for Linux available for Unix tools
- Visual Studio tools: cl, msbuild for C++ compilation`;
    } else if (isMacOS) {
        return `
COMMON MACOS DEVELOPMENT TOOLS:
- Xcode Command Line Tools: Required for many development tools
- Homebrew: Primary package manager for development tools
- Python: Usually python3, check if python points to Python 2
- Node.js: Available via brew or direct installer
- Ruby: System Ruby available, rbenv/rvm for version management`;
    } else {
        return `
COMMON LINUX DEVELOPMENT TOOLS:
- Package managers: Install tools via distribution package manager
- Python: Usually python3, python may point to Python 2
- Node.js: Available via package manager or NodeSource repository
- Build tools: gcc, make typically available or easily installed
- Container tools: docker, podman common for development`;
    }
}

/**
 * Get path guidance (simplified since paths are normalized)
 */
export function getPathGuidance(systemInfo: SystemInfo): string {
    return `Always use absolute paths for reliability. Paths are automatically normalized regardless of slash direction.`;
}