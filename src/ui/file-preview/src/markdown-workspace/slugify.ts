export type MarkdownSlugTracker = (text: string) => string;

function sanitizeSlugPart(text: string): string {
    const normalized = text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

    return normalized.length > 0 ? normalized : 'section';
}

export function slugifyMarkdownHeading(text: string): string {
    return sanitizeSlugPart(text);
}

export function createSlugTracker(): MarkdownSlugTracker {
    const counts = new Map<string, number>();

    return (text: string): string => {
        const baseSlug = slugifyMarkdownHeading(text);
        const nextCount = (counts.get(baseSlug) ?? 0) + 1;
        counts.set(baseSlug, nextCount);

        if (nextCount === 1) {
            return baseSlug;
        }

        return `${baseSlug}-${nextCount}`;
    };
}
