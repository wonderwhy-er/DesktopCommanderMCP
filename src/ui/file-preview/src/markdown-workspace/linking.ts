import { slugifyMarkdownHeading } from './slugify.js';

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

const WIKI_LINK_PATTERN = /\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
const FENCE_PATTERN = /^(`{3,}|~{3,})/;

function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, '/');
}

function normalizeFilePath(value: string): string {
    const normalized = normalizePathSeparators(value);
    return normalized.replace(/\/+/g, '/');
}

function encodeLinkPath(pathValue: string): string {
    return encodeURI(normalizePathSeparators(pathValue));
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

function buildWikiDisplayText(link: ParsedWikiLink): string {
    if (link.alias && link.alias.length > 0) {
        return link.alias;
    }

    if (link.path && link.anchor) {
        return `${link.path}#${link.anchor}`;
    }

    if (link.path) {
        return link.path;
    }

    return link.anchor ?? '';
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

function replaceWikiLinksOutsideInlineCode(line: string): string {
    const segments = line.split(/(`[^`]*`)/g);
    return segments.map((segment) => {
        if (segment.startsWith('`') && segment.endsWith('`')) {
            return segment;
        }

        return segment.replace(WIKI_LINK_PATTERN, (match) => {
            const parsed = parseWikiLink(match);
            if (!parsed) {
                return match;
            }

            const displayText = buildWikiDisplayText(parsed);
            const href = buildWikiHref(parsed);
            return `[${displayText}](${href} "mcp-wiki:${encodeURIComponent(match)}")`;
        });
    }).join('');
}

function decodeAnchorFragment(fragment: string | undefined): string | undefined {
    if (!fragment || fragment.length === 0) {
        return undefined;
    }

    return decodeURIComponent(fragment);
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

function getDirectoryPath(filePath: string): string {
    const normalized = normalizeFilePath(filePath);
    const lastSlashIndex = normalized.lastIndexOf('/');
    if (lastSlashIndex < 0) {
        return normalized;
    }

    return normalized.slice(0, lastSlashIndex);
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
    const decodedPath = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(decodedPath)) {
        return decodedPath.slice(1);
    }

    return decodedPath;
}

function isExternalHref(rawHref: string): boolean {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawHref) && !isWindowsAbsolutePath(rawHref);
}

function resolveFileTargetPath(currentPath: string, rawPath: string): string {
    const normalizedRawPath = normalizePathSeparators(decodeURIComponent(rawPath));
    if (normalizedRawPath.startsWith('/') || isWindowsAbsolutePath(normalizedRawPath)) {
        return normalizeFilePath(normalizedRawPath);
    }

    const baseDirectory = getDirectoryPath(currentPath);
    const resolvedUrl = new URL(encodeURI(normalizedRawPath), toDirectoryFileUrl(baseDirectory));
    return normalizeFilePath(fromFileUrl(resolvedUrl));
}

export function rewriteWikiLinks(source: string): string {
    const lines = source.split('\n');
    let activeFence: string | null = null;

    return lines.map((line) => {
        const trimmedStart = line.trimStart();
        const fenceMatch = trimmedStart.match(FENCE_PATTERN);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!activeFence) {
                activeFence = marker[0].repeat(marker.length);
            } else if (trimmedStart.startsWith(activeFence[0].repeat(3))) {
                activeFence = null;
            }
            return line;
        }

        if (activeFence) {
            return line;
        }

        return replaceWikiLinksOutsideInlineCode(line);
    }).join('\n');
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
