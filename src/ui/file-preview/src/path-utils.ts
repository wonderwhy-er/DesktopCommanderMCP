export function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value);
}

export function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, '/');
}

export function normalizeFilePath(value: string): string {
    const normalized = normalizePathSeparators(value);
    return normalized.replace(/\/+/g, '/');
}

function getPathRoot(value: string): string {
    const normalized = normalizeFilePath(value);
    if (isWindowsAbsolutePath(normalized)) {
        return normalized.slice(0, 3);
    }

    return normalized.startsWith('/') ? '/' : '';
}

function getPathSegments(value: string): string[] {
    const normalized = normalizeFilePath(value);
    const root = getPathRoot(normalized);
    return normalized.slice(root.length).split('/').filter(Boolean);
}

export function getParentDirectory(filePath: string): string {
    const root = getPathRoot(filePath);
    const segments = getPathSegments(filePath);
    if (segments.length <= 1) {
        return root || '.';
    }

    return `${root}${segments.slice(0, -1).join('/')}`;
}

export function getAncestorDirectories(filePath: string): string[] {
    const root = getPathRoot(filePath);
    const segments = getPathSegments(filePath);
    const ancestors: string[] = [];

    for (let index = segments.length - 1; index >= 1; index -= 1) {
        const ancestor = `${root}${segments.slice(0, index).join('/')}`;
        ancestors.push(ancestor || '.');
    }

    if (root && ancestors[ancestors.length - 1] !== root) {
        ancestors.push(root);
    }

    return ancestors;
}

export function toPosixRelativePath(fromDirectory: string, targetPath: string): string {
    const normalizedFrom = normalizeFilePath(fromDirectory);
    const normalizedTarget = normalizeFilePath(targetPath);
    const fromRoot = getPathRoot(normalizedFrom);
    const targetRoot = getPathRoot(normalizedTarget);

    if (fromRoot !== targetRoot) {
        return normalizedTarget;
    }

    const fromParts = getPathSegments(normalizedFrom);
    const targetParts = getPathSegments(normalizedTarget);
    let shared = 0;
    while (
        shared < fromParts.length
        && shared < targetParts.length
        && fromParts[shared] === targetParts[shared]
    ) {
        shared += 1;
    }

    const up = new Array(Math.max(fromParts.length - shared, 0)).fill('..');
    const down = targetParts.slice(shared);
    const joined = [...up, ...down].join('/');
    return joined.length > 0 ? joined : '.';
}
