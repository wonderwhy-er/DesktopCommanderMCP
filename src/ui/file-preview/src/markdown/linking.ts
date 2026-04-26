import { slugifyMarkdownHeading } from './slugify.js';
import { getParentDirectory, isWindowsAbsolutePath, normalizeFilePath, normalizePathSeparators } from '../path-utils.js';

export interface ResolvedMarkdownLink {
    kind: 'external' | 'anchor' | 'file';
    href: string;
    url?: string;
    targetPath?: string;
    anchor?: string;
}

interface ParsedWikiLink {
    path: string;
    anchor?: string;
    alias?: string;
}

function encodeLinkPath(pathValue: string): string {
    return encodeURI(normalizePathSeparators(pathValue));
}

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseWikiLink(rawHref: string): ParsedWikiLink | null {
    const match = rawHref.match(/^\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]$/);
    if (!match) {
        return null;
    }

    return {
        path: (match[1] ?? '').trim(),
        anchor: match[2]?.trim(),
        alias: match[3]?.trim(),
    };
}

function appendMarkdownExtension(pathValue: string): string {
    if (/\.[A-Za-z0-9_-]+$/.test(pathValue)) {
        return pathValue;
    }

    return `${pathValue}.md`;
}

function buildWikiHref(link: ParsedWikiLink): string {
    if (!link.path) {
        if (!link.anchor) {
            return '#';
        }

        return `#${slugifyMarkdownHeading(link.anchor)}`;
    }

    const normalizedPath = appendMarkdownExtension(normalizePathSeparators(link.path));
    const prefixedPath = normalizedPath.startsWith('./')
        || normalizedPath.startsWith('../')
        || normalizedPath.startsWith('/')
        || isWindowsAbsolutePath(normalizedPath)
        ? normalizedPath
        : `./${normalizedPath}`;

    const encodedPath = encodeLinkPath(prefixedPath);
    if (!link.anchor) {
        return encodedPath;
    }

    return `${encodedPath}#${slugifyMarkdownHeading(link.anchor)}`;
}

function decodeAnchorFragment(fragment: string | undefined): string | undefined {
    if (!fragment || fragment.length === 0) {
        return undefined;
    }

    return safeDecodeURIComponent(fragment);
}

function splitHref(rawHref: string): { pathPart: string; anchorPart?: string } {
    const hashIndex = rawHref.indexOf('#');
    if (hashIndex === -1) {
        return { pathPart: rawHref };
    }

    return {
        pathPart: rawHref.slice(0, hashIndex),
        anchorPart: rawHref.slice(hashIndex + 1),
    };
}

function toDirectoryFileUrl(directoryPath: string): URL {
    const normalized = normalizeFilePath(directoryPath);
    const withTrailingSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;

    if (isWindowsAbsolutePath(withTrailingSlash)) {
        return new URL(`file:///${encodeLinkPath(withTrailingSlash)}`);
    }

    if (withTrailingSlash.startsWith('/')) {
        return new URL(`file://${encodeLinkPath(withTrailingSlash)}`);
    }

    return new URL(`file:///${encodeLinkPath(withTrailingSlash)}`);
}

function fromFileUrl(url: URL): string {
    const decodedPath = safeDecodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(decodedPath)) {
        return decodedPath.slice(1);
    }

    return decodedPath;
}

function isExternalHref(rawHref: string): boolean {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawHref) && !isWindowsAbsolutePath(rawHref);
}

function resolveFileTargetPath(currentPath: string, rawPath: string): string {
    const normalizedRawPath = normalizePathSeparators(safeDecodeURIComponent(rawPath));
    if (normalizedRawPath.startsWith('/') || isWindowsAbsolutePath(normalizedRawPath)) {
        return normalizeFilePath(normalizedRawPath);
    }

    const baseDirectory = getParentDirectory(currentPath);
    if (baseDirectory === '.' && !normalizeFilePath(currentPath).includes('/')) {
        return normalizeFilePath(normalizedRawPath);
    }
    const resolvedUrl = new URL(encodeURI(normalizedRawPath), toDirectoryFileUrl(baseDirectory));
    return normalizeFilePath(fromFileUrl(resolvedUrl));
}

export function resolveMarkdownLink(currentPath: string, rawHref: string): ResolvedMarkdownLink {
    const wikiLink = parseWikiLink(rawHref);
    if (wikiLink) {
        const href = buildWikiHref(wikiLink);
        if (href.startsWith('#')) {
            return {
                kind: 'anchor',
                href: rawHref,
                anchor: decodeAnchorFragment(href.slice(1)),
            };
        }

        const [pathPart, anchorPart] = href.split('#');
        return {
            kind: 'file',
            href: rawHref,
            targetPath: resolveFileTargetPath(currentPath, pathPart),
            ...(anchorPart ? { anchor: decodeAnchorFragment(anchorPart) } : {}),
        };
    }

    if (isExternalHref(rawHref)) {
        return {
            kind: 'external',
            href: rawHref,
            url: rawHref,
        };
    }

    if (rawHref.startsWith('#')) {
        return {
            kind: 'anchor',
            href: rawHref,
            anchor: decodeAnchorFragment(rawHref.slice(1)),
        };
    }

    const { pathPart, anchorPart } = splitHref(rawHref);
    return {
        kind: 'file',
        href: rawHref,
        targetPath: resolveFileTargetPath(currentPath, pathPart),
        ...(anchorPart ? { anchor: decodeAnchorFragment(anchorPart) } : {}),
    };
}
