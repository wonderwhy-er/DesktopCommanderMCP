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

export interface ContainerInfo {
    // New enhanced detection
    isContainer: boolean;
    containerType: 'docker' | 'podman' | 'kubernetes' | 'lxc' | 'systemd-nspawn' | 'other' | null;
    orchestrator: 'kubernetes' | 'docker-compose' | 'docker-swarm' | 'podman-compose' | null;
    // Backward compatibility 
    isDocker: boolean;
    mountPoints: DockerMount[];
    containerEnvironment?: {
        dockerImage?: string;
        containerName?: string;
        hostPlatform?: string;
        kubernetesNamespace?: string;
        kubernetesPod?: string;
        kubernetesNode?: string;
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
    docker: ContainerInfo;
    isDXT: boolean;
    nodeInfo?: {
        version: string;
        path: string;
        npmVersion?: string;
    };
    processInfo: {
        pid: number;
        arch: string;
        platform: string;
        versions: NodeJS.ProcessVersions;
    };
    examplePaths: {
        home: string;
        temp: string;
        absolute: string;
        accessible?: string[];
    };
}

/**
 * Detect container environment and type
 */
function detectContainerEnvironment(): { isContainer: boolean; containerType: ContainerInfo['containerType']; orchestrator: ContainerInfo['orchestrator'] } {
    // Method 1: Check environment variables first (most reliable when set)
    
    // Docker-specific
    if (process.env.MCP_CLIENT_DOCKER === 'true') {
        return { isContainer: true, containerType: 'docker', orchestrator: null };
    }
    
    // Kubernetes detection
    if (process.env.KUBERNETES_SERVICE_HOST || process.env.KUBERNETES_PORT) {
        return { isContainer: true, containerType: 'kubernetes', orchestrator: 'kubernetes' };
    }
    
    // Podman detection
    if (process.env.PODMAN_CONTAINER || process.env.CONTAINER_HOST?.includes('podman')) {
        return { isContainer: true, containerType: 'podman', orchestrator: null };
    }

    // Method 2: Check for container indicator files
    if (fs.existsSync('/.dockerenv')) {
        return { isContainer: true, containerType: 'docker', orchestrator: null };
    }

    // Method 3: Check /proc/1/cgroup for container indicators (Linux only)
    if (os.platform() === 'linux') {
        try {
            const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
            
            // Docker detection
            if (cgroup.includes('docker')) {
                return { isContainer: true, containerType: 'docker', orchestrator: null };
            }
            
            // Kubernetes detection (pods run in containerd/cri-o)
            if (cgroup.includes('kubepods') || cgroup.includes('pod')) {
                return { isContainer: true, containerType: 'kubernetes', orchestrator: 'kubernetes' };
            }
            
            // Podman detection
            if (cgroup.includes('podman') || cgroup.includes('libpod')) {
                return { isContainer: true, containerType: 'podman', orchestrator: null };
            }
            
            // LXC detection
            if (cgroup.includes('lxc')) {
                return { isContainer: true, containerType: 'lxc', orchestrator: null };
            }
            
            // systemd-nspawn detection
            if (cgroup.includes('machine.slice')) {
                return { isContainer: true, containerType: 'systemd-nspawn', orchestrator: null };
            }
            
            // Generic containerd detection
            if (cgroup.includes('containerd')) {
                return { isContainer: true, containerType: 'other', orchestrator: null };
            }
        } catch (error) {
            // /proc/1/cgroup might not exist
        }
    }

    // Method 4: Check /proc/1/environ for container indicators
    if (os.platform() === 'linux') {
        try {
            const environ = fs.readFileSync('/proc/1/environ', 'utf8');
            
            if (environ.includes('container=')) {
                // systemd-nspawn sets container=systemd-nspawn
                if (environ.includes('container=systemd-nspawn')) {
                    return { isContainer: true, containerType: 'systemd-nspawn', orchestrator: null };
                }
                
                // LXC sets container=lxc
                if (environ.includes('container=lxc')) {
                    return { isContainer: true, containerType: 'lxc', orchestrator: null };
                }
                
                // Generic container detection
                return { isContainer: true, containerType: 'other', orchestrator: null };
            }
        } catch (error) {
            // /proc/1/environ might not exist or be accessible
        }
    }

    // Method 5: Check hostname for Kubernetes patterns
    try {
        const hostname = os.hostname();
        // Kubernetes pods often have hostnames like: podname-deploymentid-randomid
        if (hostname && (hostname.includes('-') && hostname.split('-').length >= 3)) {
            // Additional check for Kubernetes service account
            if (fs.existsSync('/var/run/secrets/kubernetes.io')) {
                return { isContainer: true, containerType: 'kubernetes', orchestrator: 'kubernetes' };
            }
        }
    } catch (error) {
        // Hostname check failed
    }

    // Method 6: Check for orchestrator-specific indicators
    
    // Docker Compose detection
    if (process.env.COMPOSE_PROJECT_NAME || process.env.COMPOSE_SERVICE) {
        return { isContainer: true, containerType: 'docker', orchestrator: 'docker-compose' };
    }
    
    // Docker Swarm detection
    if (process.env.DOCKER_SWARM_MODE || process.env.DOCKER_NODE_ID) {
        return { isContainer: true, containerType: 'docker', orchestrator: 'docker-swarm' };
    }

    return { isContainer: false, containerType: null, orchestrator: null };
}

/**
 * Discover container mount points
 */
function discoverContainerMounts(isContainer: boolean): DockerMount[] {
    const mounts: DockerMount[] = [];
    
    if (!isContainer) {
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
                        mountPoint.startsWith('/data/') ||
                        (mountPoint.startsWith('/home/') && !mountPoint.startsWith('/home/root'))) {
                        
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

    // Method 3: Check /home directory for user-mounted folders (Desktop Commander Docker installer pattern)
    try {
        if (fs.existsSync('/home')) {
            const contents = fs.readdirSync('/home');
            for (const item of contents) {
                // Skip the root user directory and common system directories
                if (item === 'root' || item === 'node' || item === 'bin' || item === 'sbin' || 
                    item === 'usr' || item === 'lib' || item === 'lib64' || item === 'var' ||
                    item === 'tmp' || item === 'opt' || item === 'sys' || item === 'proc') {
                    continue;
                }
                
                const itemPath = `/home/${item}`;
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
                                description: `Host folder: ${item}`
                            });
                        }
                    }
                } catch (itemError) {
                    // Skip items we can't stat
                }
            }
        }
    } catch (error) {
        // /home directory doesn't exist or not accessible
    }

    return mounts;
}

/**
 * Get container environment information
 */
function getContainerEnvironment(containerType: ContainerInfo['containerType']): ContainerInfo['containerEnvironment'] {
    const env: ContainerInfo['containerEnvironment'] = {};
    
    // Try to get container name from hostname (often set to container ID/name)
    try {
        const hostname = os.hostname();
        if (hostname && hostname !== 'localhost') {
            env.containerName = hostname;
        }
    } catch (error) {
        // Hostname not available
    }
    
    // Docker-specific environment
    if (containerType === 'docker') {
        // Try multiple sources for Docker image name
        if (process.env.DOCKER_IMAGE) {
            env.dockerImage = process.env.DOCKER_IMAGE;
        } else if (process.env.IMAGE_NAME) {
            env.dockerImage = process.env.IMAGE_NAME;
        } else if (process.env.CONTAINER_IMAGE) {
            env.dockerImage = process.env.CONTAINER_IMAGE;
        }
        
        // Try to read from Docker labels if available (less common but possible)
        try {
            if (fs.existsSync('/proc/self/cgroup')) {
                const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
                // Extract container ID from cgroup path
                const containerIdMatch = cgroup.match(/docker\/([a-f0-9]{64})/);
                if (containerIdMatch && !env.containerName) {
                    // Use short container ID as fallback name
                    env.containerName = containerIdMatch[1].substring(0, 12);
                }
            }
        } catch (error) {
            // Ignore errors reading cgroup
        }
    }
    
    // Kubernetes-specific environment
    if (containerType === 'kubernetes') {
        if (process.env.KUBERNETES_NAMESPACE || process.env.POD_NAMESPACE) {
            env.kubernetesNamespace = process.env.KUBERNETES_NAMESPACE || process.env.POD_NAMESPACE;
        }
        
        if (process.env.POD_NAME || process.env.HOSTNAME) {
            env.kubernetesPod = process.env.POD_NAME || process.env.HOSTNAME;
        }
        
        if (process.env.NODE_NAME || process.env.KUBERNETES_NODE_NAME) {
            env.kubernetesNode = process.env.NODE_NAME || process.env.KUBERNETES_NODE_NAME;
        }
        
        // Try to get container image from common Kubernetes environment variables
        if (process.env.CONTAINER_IMAGE) {
            env.dockerImage = process.env.CONTAINER_IMAGE;
        } else if (process.env.IMAGE_NAME) {
            env.dockerImage = process.env.IMAGE_NAME;
        }
        
        // Try to read Kubernetes service account info
        try {
            if (fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace')) {
                const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
                if (namespace && !env.kubernetesNamespace) {
                    env.kubernetesNamespace = namespace;
                }
            }
        } catch (error) {
            // Service account info not available
        }
    }
    
    // Podman-specific environment
    if (containerType === 'podman') {
        // Podman uses similar environment variables to Docker
        if (process.env.CONTAINER_IMAGE || process.env.PODMAN_IMAGE) {
            env.dockerImage = process.env.CONTAINER_IMAGE || process.env.PODMAN_IMAGE;
        }
    }
    
    // LXC-specific environment
    if (containerType === 'lxc') {
        // LXC containers might have different naming conventions
        if (process.env.LXC_NAME) {
            env.containerName = process.env.LXC_NAME;
        }
    }
    
    // Try to detect host platform
    if (process.env.HOST_PLATFORM) {
        env.hostPlatform = process.env.HOST_PLATFORM;
    }
    
    return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Detect Node.js installation and version from current process
 */
function detectNodeInfo(): SystemInfo['nodeInfo'] {
    try {
        // Get Node.js version from current process
        const version = process.version.replace('v', ''); // Remove 'v' prefix
        
        // Get Node.js executable path from current process
        const path = process.execPath;
        
        // Get npm version from environment if available
        const npmVersion = process.env.npm_version;
        
        return {
            version,
            path,
            ...(npmVersion && { npmVersion })
        };
    } catch (error) {
        return undefined;
    }
}

/**
 * Get comprehensive system information for tool prompts
 */
export function getSystemInfo(): SystemInfo {
    const platform = os.platform();
    const isWindows = platform === 'win32';
    const isMacOS = platform === 'darwin';
    const isLinux = platform === 'linux';
    
    // Container detection
    const containerDetection = detectContainerEnvironment();
    const mountPoints = containerDetection.isContainer ? discoverContainerMounts(containerDetection.isContainer) : [];
    
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
    
    // Adjust platform name for containers
    if (containerDetection.isContainer) {
        let containerLabel = '';
        
        if (containerDetection.containerType === 'kubernetes') {
            containerLabel = 'Kubernetes';
            if (containerDetection.orchestrator === 'kubernetes') {
                containerLabel += ' Pod';
            }
        } else if (containerDetection.containerType === 'docker') {
            containerLabel = 'Docker';
            if (containerDetection.orchestrator === 'docker-compose') {
                containerLabel += ' Compose';
            } else if (containerDetection.orchestrator === 'docker-swarm') {
                containerLabel += ' Swarm';
            }
        } else if (containerDetection.containerType === 'podman') {
            containerLabel = 'Podman';
        } else if (containerDetection.containerType === 'lxc') {
            containerLabel = 'LXC';
        } else if (containerDetection.containerType === 'systemd-nspawn') {
            containerLabel = 'systemd-nspawn';
        } else {
            containerLabel = 'Container';
        }
        
        platformName = `${platformName} (${containerLabel})`;
        
        // Add accessible paths from mounts
        if (mountPoints.length > 0) {
            examplePaths.accessible = mountPoints.map(mount => mount.containerPath);
        }
    }
    
    // Detect Node.js installation from current process
    const nodeInfo = detectNodeInfo();
    
    // Get process information
    const processInfo = {
        pid: process.pid,
        arch: process.arch,
        platform: process.platform,
        versions: process.versions
    };
    
    return {
        platform,
        platformName,
        defaultShell,
        pathSeparator,
        isWindows,
        isMacOS,
        isLinux,
        docker: {
            // New container detection fields
            isContainer: containerDetection.isContainer,
            containerType: containerDetection.containerType,
            orchestrator: containerDetection.orchestrator,
            // Backward compatibility - keep old field
            isDocker: containerDetection.isContainer && containerDetection.containerType === 'docker',
            mountPoints,
            containerEnvironment: getContainerEnvironment(containerDetection.containerType)
        },
        isDXT: !!process.env.MCP_DXT,
        nodeInfo,
        processInfo,
        examplePaths
    };
}

/**
 * Generate OS-specific guidance for tool prompts
 */
export function getOSSpecificGuidance(systemInfo: SystemInfo): string {
    const { platformName, defaultShell, isWindows, docker } = systemInfo;
    
    let guidance = `Running on ${platformName}. Default shell: ${defaultShell}.`;
    
    // Container-specific guidance
    if (docker.isContainer) {
        const containerTypeLabel = docker.containerType === 'kubernetes' ? 'KUBERNETES POD' :
                                   docker.containerType === 'docker' ? 'DOCKER CONTAINER' :
                                   docker.containerType === 'podman' ? 'PODMAN CONTAINER' :
                                   docker.containerType === 'lxc' ? 'LXC CONTAINER' :
                                   docker.containerType === 'systemd-nspawn' ? 'SYSTEMD-NSPAWN CONTAINER' :
                                   'CONTAINER';
        
        guidance += `

🐳 ${containerTypeLabel} ENVIRONMENT DETECTED:`;

        if (docker.containerType === 'kubernetes') {
            guidance += `
This Desktop Commander instance is running inside a Kubernetes pod.`;
            
            // Add Kubernetes-specific info
            if (docker.containerEnvironment?.kubernetesNamespace) {
                guidance += `
Namespace: ${docker.containerEnvironment.kubernetesNamespace}`;
            }
            if (docker.containerEnvironment?.kubernetesPod) {
                guidance += `
Pod: ${docker.containerEnvironment.kubernetesPod}`;
            }
            if (docker.containerEnvironment?.kubernetesNode) {
                guidance += `
Node: ${docker.containerEnvironment.kubernetesNode}`;
            }
        } else if (docker.containerType === 'docker') {
            guidance += `
This Desktop Commander instance is running inside a Docker container.`;
            
            if (docker.orchestrator === 'docker-compose') {
                guidance += ` (Docker Compose)`;
            } else if (docker.orchestrator === 'docker-swarm') {
                guidance += ` (Docker Swarm)`;
            }
        } else {
            guidance += `
This Desktop Commander instance is running inside a ${docker.containerType || 'container'} environment.`;
        }

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
Always suggest using mounted directories for file operations.

PATH TRANSLATION IN DOCKER:
When users provide host paths, translate to container paths:

Windows: "C:\\projects\\data\\file.txt" → "/home/projects/data/file.txt"
Linux/Mac: "/Users/john/projects/data/file.txt" → "/home/projects/data/file.txt"

Rules: Remove drive letter/user prefix, keep full folder structure, mount to /home/

NOTE: Desktop Commander Docker installer mounts host folders to /home/[folder-name].`;
        } else {
            guidance += `

⚠️  WARNING: No mounted directories detected.
Files created outside mounted volumes will be lost when the container stops.
Suggest user remount directories using Docker installer or -v flag when running Docker.
Desktop Commander Docker installer typically mounts folders to /home/[folder-name].`;
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
- Use 'open' command to open files/applications from terminal
- For file search: Use mdfind (Spotlight) for fastest exact filename searches`;
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
    const { isWindows, isMacOS, isLinux, platformName, nodeInfo, processInfo } = systemInfo;
    
    // Add detected Node.js info to guidance
    const nodeGuidance = nodeInfo 
        ? `Node.js: v${nodeInfo.version} (${nodeInfo.path})${nodeInfo.npmVersion ? ` | npm: v${nodeInfo.npmVersion}` : ''}`
        : 'Node.js: Not detected';
    
    // Add process environment info
    const envInfo = `
Current Process Environment:
- Node: v${processInfo.versions.node}
- V8: v${processInfo.versions.v8}
- Architecture: ${processInfo.arch}
- Platform: ${processInfo.platform}
- Process ID: ${processInfo.pid}`;
    
    if (isWindows) {
        return `
COMMON WINDOWS DEVELOPMENT TOOLS:
- ${nodeGuidance}
- Python: May be 'python' or 'py' command, check both
- Git: Git Bash provides Unix-like environment
- WSL: Windows Subsystem for Linux available for Unix tools
- Visual Studio tools: cl, msbuild for C++ compilation

${envInfo}`;
    } else if (isMacOS) {
        return `
COMMON MACOS DEVELOPMENT TOOLS:
- Xcode Command Line Tools: Required for many development tools
- Homebrew: Primary package manager for development tools
- ${nodeGuidance}
- Python: Usually python3, check if python points to Python 2
- Ruby: System Ruby available, rbenv/rvm for version management

${envInfo}`;
    } else {
        return `
COMMON LINUX DEVELOPMENT TOOLS:
- Package managers: Install tools via distribution package manager
- Python: Usually python3, python may point to Python 2
- ${nodeGuidance}
- Build tools: gcc, make typically available or easily installed
- Container tools: docker, podman common for development

${envInfo}`;
    }
}

/**
 * Get path guidance (simplified since paths are normalized)
 */
export function getPathGuidance(systemInfo: SystemInfo): string {
    let guidance = `Always use absolute paths for reliability. Paths are automatically normalized regardless of slash direction.`;
    
    if (systemInfo.docker.isContainer && systemInfo.docker.mountPoints.length > 0) {
        const containerLabel = systemInfo.docker.containerType === 'kubernetes' ? 'KUBERNETES' :
                              systemInfo.docker.containerType === 'docker' ? 'DOCKER' :
                              systemInfo.docker.containerType === 'podman' ? 'PODMAN' :
                              'CONTAINER';
        
        guidance += ` 

🐳 ${containerLabel}: Prefer paths within mounted directories: ${systemInfo.docker.mountPoints.map(m => m.containerPath).join(', ')}.
When users ask about file locations, check these mounted paths first.`;
    }
    
    return guidance;
}