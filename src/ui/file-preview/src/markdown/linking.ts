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

const WIKI_LINK_PATTERN = /\[\[([^\]|#]*)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
const FENCE_PATTERN = /^(`{3,}|~{3,})/;

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

function rewriteWikiLinksInPlainText(segment: string): string {
    return segment.replace(WIKI_LINK_PATTERN, (match) => {
        const parsed = parseWikiLink(match);
        if (!parsed) {
            return match;
        }

        const displayText = buildWikiDisplayText(parsed);
        const href = buildWikiHref(parsed);
        return `[${displayText}](${href} "mcp-wiki:${encodeURIComponent(match)}")`;
    });
}

function replaceWikiLinksOutsideInlineCode(line: string): string {
    let result = '';
    let cursor = 0;

    while (cursor < line.length) {
        const codeStart = line.indexOf('`', cursor);
        if (codeStart === -1) {
            result += rewriteWikiLinksInPlainText(line.slice(cursor));
            break;
        }

        result += rewriteWikiLinksInPlainText(line.slice(cursor, codeStart));

        let delimiterEnd = codeStart;
        while (delimiterEnd < line.length && line[delimiterEnd] === '`') {
            delimiterEnd += 1;
        }

        const delimiter = line.slice(codeStart, delimiterEnd);
        const codeEnd = line.indexOf(delimiter, delimiterEnd);
        if (codeEnd === -1) {
            result += line.slice(codeStart);
            break;
        }

        result += line.slice(codeStart, codeEnd + delimiter.length);
        cursor = codeEnd + delimiter.length;
    }

    return result;
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

/**
 * Invert `rewriteWikiLinks`: convert `[alias](href "mcp-wiki:ENCODED")` links
 * back to their original `[[...]]` form. Used when serializing a WYSIWYG
 * edit session back to markdown — the `mcp-wiki:` title prefix is the
 * round-trip marker written by `rewriteWikiLinks`.
 */
export function restoreWikiLinks(markdown: string): string {
    return markdown.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"mcp-wiki:([^"]+)")\)/g, (_, _alias, _href, encoded) => {
        try {
            return decodeURIComponent(encoded);
        } catch {
            return `[[${encoded}]]`;
        }
    });
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
                activeFence = marker;
            } else if (marker[0] === activeFence[0] && marker.length >= activeFence.length) {
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
