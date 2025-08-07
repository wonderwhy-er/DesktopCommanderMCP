import os from 'os';
import fs from 'fs';
import path from 'path';

export interface DockerMount {
    hostPath: string;
    containerPath: string;
    type: 'bind' | 'volume';
    readOnly: boolean;
    description: string;
}

export interface DockerInfo {
    isDocker: boolean;
    mountPoints: DockerMount[];
    containerEnvironment?: {
        dockerImage?: string;
        containerName?: string;
        hostPlatform?: string;
    };
}

export interface SystemInfo {
    platform: string;
    platformName: string;
    defaultShell: string;
    pathSeparator: string;
    isWindows: boolean;
    isMacOS: boolean;
    isLinux: boolean;
    docker: DockerInfo;
    examplePaths: {
        home: string;
        temp: string;
        absolute: string;
        accessible?: string[];
    };
}

/**
 * Detect if running inside Docker container
 */
function isRunningInDocker(): boolean {
    // Method 1: MCP_CLIENT_DOCKER environment variable (set in Dockerfile)
    if (process.env.MCP_CLIENT_DOCKER === 'true') {
        return true;
    }

    // Method 2: Check for .dockerenv file
    if (fs.existsSync('/.dockerenv')) {
        return true;
    }

    // Method 3: Check /proc/1/cgroup for container indicators (Linux only)
    if (os.platform() === 'linux') {
        try {
            const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
            if (cgroup.includes('docker') || cgroup.includes('containerd')) {
                return true;
            }
        } catch (error) {
            // /proc/1/cgroup might not exist
        }
    }

    return false;
}

/**
 * Discover Docker mount points
 */
function discoverDockerMounts(): DockerMount[] {
    const mounts: DockerMount[] = [];
    
    if (!isRunningInDocker()) {
        return mounts;
    }

    // Method 1: Parse /proc/mounts (Linux only)
    if (os.platform() === 'linux') {
        try {
            const mountsContent = fs.readFileSync('/proc/mounts', 'utf8');
            const mountLines = mountsContent.split('\n');
            
            for (const line of mountLines) {
                const parts = line.split(' ');
                if (parts.length >= 4) {
                    const device = parts[0];
                    const mountPoint = parts[1];
                    const options = parts[3];

                    // Look for user mounts (skip system mounts)
                    if (mountPoint.startsWith('/mnt/') || 
                        mountPoint.startsWith('/workspace') ||
                        mountPoint.startsWith('/data/')) {
                        
                        const isReadOnly = options.includes('ro');
                        
                        mounts.push({
                            hostPath: device,
                            containerPath: mountPoint,
                            type: 'bind',
                            readOnly: isReadOnly,
                            description: `Mounted directory: ${path.basename(mountPoint)}`
                        });
                    }
                }
            }
        } catch (error) {
            // /proc/mounts might not be available
        }
    }

    // Method 2: Check /mnt directory contents
    try {
        if (fs.existsSync('/mnt')) {
            const contents = fs.readdirSync('/mnt');
            for (const item of contents) {
                const itemPath = `/mnt/${item}`;
                try {
                    const stats = fs.statSync(itemPath);
                    if (stats.isDirectory()) {
                        // Check if we already have this mount
                        const exists = mounts.some(m => m.containerPath === itemPath);
                        if (!exists) {
                            mounts.push({
                                hostPath: `<host>/${item}`,
                                containerPath: itemPath,
                                type: 'bind',
                                readOnly: false,
                                description: `Mounted folder: ${item}`
                            });
                        }
                    }
                } catch (itemError) {
                    // Skip items we can't stat
                }
            }
        }
    } catch (error) {
        // /mnt directory doesn't exist or not accessible
    }

    return mounts;
}

/**
 * Get container environment information
 */
function getContainerEnvironment(): DockerInfo['containerEnvironment'] {
    const env: DockerInfo['containerEnvironment'] = {};
    
    // Try to get container name from hostname (often set to container ID/name)
    try {
        const hostname = os.hostname();
        if (hostname && hostname !== 'localhost') {
            env.containerName = hostname;
        }
    } catch (error) {
        // Hostname not available
    }
    
    // Try to get Docker image from environment variables
    if (process.env.DOCKER_IMAGE) {
        env.dockerImage = process.env.DOCKER_IMAGE;
    }
    
    // Try to detect host platform
    if (process.env.HOST_PLATFORM) {
        env.hostPlatform = process.env.HOST_PLATFORM;
    }
    
    return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Get comprehensive system information for tool prompts
 */
export function getSystemInfo(): SystemInfo {
    const platform = os.platform();
    const isWindows = platform === 'win32';
    const isMacOS = platform === 'darwin';
    const isLinux = platform === 'linux';
    
    // Docker detection
    const dockerDetected = isRunningInDocker();
    const mountPoints = dockerDetected ? discoverDockerMounts() : [];
    
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
    
    // Adjust platform name for Docker
    if (dockerDetected) {
        platformName = `${platformName} (Docker)`;
        
        // Add accessible paths from mounts
        if (mountPoints.length > 0) {
            examplePaths.accessible = mountPoints.map(mount => mount.containerPath);
        }
    }
    
    return {
        platform,
        platformName,
        defaultShell,
        pathSeparator,
        isWindows,
        isMacOS,
        isLinux,
        docker: {
            isDocker: dockerDetected,
            mountPoints,
            containerEnvironment: getContainerEnvironment()
        },
        examplePaths
    };
}

/**
 * Generate OS-specific guidance for tool prompts
 */
export function getOSSpecificGuidance(systemInfo: SystemInfo): string {
    const { platformName, defaultShell, isWindows, docker } = systemInfo;
    
    let guidance = `Running on ${platformName}. Default shell: ${defaultShell}.`;
    
    // Docker-specific guidance
    if (docker.isDocker) {
        guidance += `

🐳 DOCKER ENVIRONMENT DETECTED:
This Desktop Commander instance is running inside a Docker container.`;

        if (docker.mountPoints.length > 0) {
            guidance += `

AVAILABLE MOUNTED DIRECTORIES:`;
            for (const mount of docker.mountPoints) {
                const access = mount.readOnly ? '(read-only)' : '(read-write)';
                guidance += `
- ${mount.containerPath} ${access} - ${mount.description}`;
            }
            
            guidance += `

IMPORTANT: When users ask about files, FIRST check mounted directories above.
Files outside these paths will be lost when the container stops.
Always suggest using mounted directories for file operations.`;
        } else {
            guidance += `

⚠️  WARNING: No mounted directories detected.
Files created outside mounted volumes will be lost when the container stops.
Suggest user mount directories using -v flag when running Docker.`;
        }

        if (docker.containerEnvironment?.containerName) {
            guidance += `
Container: ${docker.containerEnvironment.containerName}`;
        }
    }
    
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
    let guidance = `Always use absolute paths for reliability. Paths are automatically normalized regardless of slash direction.`;
    
    if (systemInfo.docker.isDocker && systemInfo.docker.mountPoints.length > 0) {
        guidance += ` 

🐳 DOCKER: Prefer paths within mounted directories: ${systemInfo.docker.mountPoints.map(m => m.containerPath).join(', ')}.
When users ask about file locations, check these mounted paths first.`;
    }
    
    return guidance;
}