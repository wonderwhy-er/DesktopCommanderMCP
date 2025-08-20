import os from 'os';
import fs from 'fs';

export interface ContainerInfo {
    isContainer: boolean;
    runtime?: 'docker' | 'podman' | 'containerd' | 'kubernetes' | 'lxc' | 'systemd-nspawn' | 'unknown';
    detectionMethods: string[];
    confidence: 'high' | 'medium' | 'low';
    details?: {
        cgroupInfo?: string;
        mountInfo?: string;
        initProcess?: string;
        containerEnv?: string;
    };
}

/**
 * Enhanced container detection with multiple methods and confidence scoring
 */
export function detectContainerEnvironment(): ContainerInfo {
    const detectionMethods: string[] = [];
    let runtime: ContainerInfo['runtime'] = undefined;
    let confidence: ContainerInfo['confidence'] = 'low';
    const details: ContainerInfo['details'] = {};

    // Method 1: Environment variable override (highest confidence)
    if (process.env.MCP_CLIENT_DOCKER === 'true') {
        detectionMethods.push('MCP_CLIENT_DOCKER env var');
        runtime = 'docker';
        confidence = 'high';
        details.containerEnv = 'MCP_CLIENT_DOCKER=true';
    }

    // Method 2: Standard container environment variables
    const containerEnvVars = [
        'DOCKER_CONTAINER',
        'CONTAINER',
        'KUBERNETES_SERVICE_HOST',
        'K8S_NODE_NAME'
    ];
    
    for (const envVar of containerEnvVars) {
        if (process.env[envVar]) {
            detectionMethods.push(`${envVar} env var`);
            if (envVar.includes('KUBERNETES') || envVar.includes('K8S')) {
                runtime = 'kubernetes';
            } else if (envVar.includes('DOCKER')) {
                runtime = 'docker';
            }
            confidence = 'high';
            details.containerEnv = `${envVar}=${process.env[envVar]}`;
        }
    }

    // Method 3: Check for container marker files
    const containerFiles = [
        { path: '/.dockerenv', runtime: 'docker' as const },
        { path: '/.containerenv', runtime: 'podman' as const },
        { path: '/run/.containerenv', runtime: 'podman' as const }
    ];

    for (const file of containerFiles) {
        if (fs.existsSync(file.path)) {
            detectionMethods.push(`${file.path} file exists`);
            runtime = file.runtime;
            confidence = 'high';
        }
    }

    // Method 4: Enhanced cgroup analysis (Linux only)
    if (os.platform() === 'linux') {
        try {
            const cgroupPaths = ['/proc/1/cgroup', '/proc/self/cgroup'];
            
            for (const cgroupPath of cgroupPaths) {
                if (fs.existsSync(cgroupPath)) {
                    const cgroup = fs.readFileSync(cgroupPath, 'utf8');
                    details.cgroupInfo = cgroup;

                    const containerIndicators = [
                        { pattern: /docker/i, runtime: 'docker' as const },
                        { pattern: /containerd/i, runtime: 'containerd' as const },
                        { pattern: /kubepods/i, runtime: 'kubernetes' as const },
                        { pattern: /libpod/i, runtime: 'podman' as const },
                        { pattern: /lxc/i, runtime: 'lxc' as const },
                        { pattern: /machine\.slice/i, runtime: 'systemd-nspawn' as const },
                        { pattern: /\.scope$/m, runtime: 'unknown' as const } // Generic container scope
                    ];

                    for (const indicator of containerIndicators) {
                        if (indicator.pattern.test(cgroup)) {
                            detectionMethods.push(`cgroup ${indicator.runtime} pattern`);
                            if (!runtime || runtime === 'unknown') {
                                runtime = indicator.runtime;
                            }
                            confidence = confidence === 'low' ? 'medium' : confidence;
                            break;
                        }
                    }
                    break;
                }
            }
        } catch (error) {
            // cgroup files might not be accessible
        }
    }

    // Method 5: Mount information analysis (Linux only)
    if (os.platform() === 'linux') {
        try {
            const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
            details.mountInfo = mountInfo.substring(0, 500); // First 500 chars for debugging

            // Look for overlay filesystem (common in containers)
            if (mountInfo.includes('overlay')) {
                detectionMethods.push('overlay filesystem detected');
                confidence = confidence === 'low' ? 'medium' : confidence;
            }

            // Look for container-specific mount paths
            const containerMountPatterns = [
                /\/var\/lib\/docker/,
                /\/var\/lib\/containers/,
                /\/run\/containerd/,
                /\/var\/lib\/kubelet/
            ];

            for (const pattern of containerMountPatterns) {
                if (pattern.test(mountInfo)) {
                    detectionMethods.push(`container mount pattern: ${pattern.source}`);
                    confidence = confidence === 'low' ? 'medium' : confidence;
                }
            }
        } catch (error) {
            // /proc/self/mountinfo might not be accessible
        }
    }

    // Method 6: Init process analysis (Linux only)
    if (os.platform() === 'linux') {
        try {
            const cmdline = fs.readFileSync('/proc/1/cmdline', 'utf8');
            details.initProcess = cmdline.replace(/\0/g, ' ').trim();

            // Container runtimes often have specific init processes
            const initPatterns = [
                { pattern: /runc/, runtime: 'docker' as const },
                { pattern: /crun/, runtime: 'podman' as const },
                { pattern: /containerd-shim/, runtime: 'containerd' as const },
                { pattern: /pause/, runtime: 'kubernetes' as const }
            ];

            for (const initPattern of initPatterns) {
                if (initPattern.pattern.test(cmdline)) {
                    detectionMethods.push(`init process: ${initPattern.runtime}`);
                    if (!runtime || runtime === 'unknown') {
                        runtime = initPattern.runtime;
                    }
                    confidence = confidence === 'low' ? 'medium' : confidence;
                }
            }
        } catch (error) {
            // /proc/1/cmdline might not be accessible
        }
    }

    // Method 7: Hostname analysis
    try {
        const hostname = os.hostname();
        
        // Docker containers often have hex-like hostnames
        if (hostname && /^[a-f0-9]{12}$/.test(hostname)) {
            detectionMethods.push('docker-style hostname pattern');
            if (!runtime) {
                runtime = 'docker';
            }
            confidence = confidence === 'low' ? 'medium' : confidence;
        }
        
        // Kubernetes pods often have specific naming patterns
        if (hostname && /-[a-z0-9]{5,10}-[a-z0-9]{5}$/.test(hostname)) {
            detectionMethods.push('kubernetes-style hostname pattern');
            runtime = 'kubernetes';
            confidence = confidence === 'low' ? 'medium' : confidence;
        }
    } catch (error) {
        // hostname not available
    }

    // Method 8: Check for container-specific directories
    const containerDirs = [
        '/var/run/docker.sock',
        '/run/containerd/containerd.sock',
        '/var/run/podman',
        '/var/lib/kubelet'
    ];

    for (const dir of containerDirs) {
        if (fs.existsSync(dir)) {
            detectionMethods.push(`container socket/dir: ${dir}`);
            confidence = confidence === 'low' ? 'medium' : confidence;
        }
    }

    const isContainer = detectionMethods.length > 0;

    return {
        isContainer,
        runtime,
        detectionMethods,
        confidence,
        details
    };
}

/**
 * Simple boolean check for backward compatibility
 */
export function isRunningInContainer(): boolean {
    return detectContainerEnvironment().isContainer;
}

/**
 * Get detailed container information for logging
 */
export function getContainerDetails(): string {
    const info = detectContainerEnvironment();
    
    if (!info.isContainer) {
        return 'Not running in container';
    }

    const runtime = info.runtime || 'unknown';
    const methods = info.detectionMethods.join(', ');
    
    return `Container: ${runtime} (${info.confidence} confidence) - Methods: ${methods}`;
}
