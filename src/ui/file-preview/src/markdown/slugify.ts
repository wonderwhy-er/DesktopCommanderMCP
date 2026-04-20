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
    const usedSlugs = new Set<string>();

    return (text: string): string => {
        const baseSlug = slugifyMarkdownHeading(text);
        let nextCount = counts.get(baseSlug) ?? 1;
        let nextSlug = nextCount === 1 ? baseSlug : `${baseSlug}-${nextCount}`;

        while (usedSlugs.has(nextSlug)) {
            nextCount += 1;
            nextSlug = `${baseSlug}-${nextCount}`;
        }

        counts.set(baseSlug, nextCount + 1);
        usedSlugs.add(nextSlug);
        return nextSlug;
    };
}
