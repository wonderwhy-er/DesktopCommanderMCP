import { Editor } from '@tiptap/core';
import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Markdown } from 'tiptap-markdown';
import { restoreWikiLinks, rewriteWikiLinks } from './linking.js';
import { createSlugTracker } from './slugify.js';

export type MarkdownEditorView = 'raw' | 'markdown';

/**
 * Round-trip safety wrapper around Tiptap.
 *
 * Tiptap parses markdown into ProseMirror nodes and serializes back via
 * tiptap-markdown. Both steps are inherently lossy — features like GFM
 * tables, wikilinks, YAML frontmatter, escapable characters and exact
 * whitespace can't be recovered exactly from the parsed tree. The wrappers
 * below preserve those features by:
 *
 *   1. Stripping content the editor can't safely round-trip (YAML
 *      frontmatter, CRLF line endings) BEFORE handing markdown to Tiptap,
 *      and re-attaching it after serialization.
 *   2. Calling existing helpers (rewriteWikiLinks / restoreWikiLinks) that
 *      replace `[[Page]]` with placeholder syntax Tiptap understands,
 *      then put it back on the way out.
 *   3. Preserving a trailing newline if the original document ended with
 *      one — Tiptap's serializer always strips it.
 *
 * The shape of the safe region we save is captured in a `RoundTripContext`
 * so post-processing can mirror it back. The test suite imports these
 * helpers directly so the regression suite tests the EXACT same code path
 * that production runs at autosave time.
 */
export interface RoundTripContext {
    /** Original document text, retained for any final repair pass. */
    originalInput: string;
    /** YAML frontmatter prefix (`---\n…\n---\n`) stripped before editing. */
    frontmatter: string;
    /** Newlines between frontmatter end and first body line. Tiptap strips
     *  these; we put them back exactly. */
    frontmatterGap: string;
    /** Trailing newline that was on the original; restored after serialize. */
    trailingNewline: string;
    /** EOL convention of the original (`'\r\n'` or `'\n'`). */
    eol: '\r\n' | '\n';
    /** Code-text links (`[\`x\`](url)`) replaced with placeholders during
     *  preprocessing, restored after serialization. tiptap-markdown drops
     *  the URL when a link's text is purely inline code. */
    codeLinks: Array<{ placeholder: string; original: string }>;
    /** `**...\`code\`...**` constructs replaced with placeholders. Tiptap's
     *  ProseMirror schema can't cleanly represent a bold mark wrapping
     *  inline code; it splits the bold around the code in non-obvious
     *  ways. */
    boldCodeRuns: Array<{ placeholder: string; original: string }>;
    /** Count of `\|` escapes that were replaced with placeholders during
     *  preprocess. Each `\|` is replaced by a single ASCII token that
     *  restoration converts back to the literal `\|` in the output. */
    pipeEscapeCount: number;
}

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/;

// Match any markdown inline link: `[text](url)`. We don't restrict the
// text or URL further at the regex level — instead, isFragileLink()
// inspects each match to decide whether Tiptap would mangle it.
const INLINE_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// Match a `**…**` bold span whose contents contain at least one inline
// code segment. ProseMirror's flat-mark schema can't cleanly represent a
// bold wrapping inline code, so Tiptap shifts the bold delimiters around
// the code in non-obvious ways on serialize. We placeholder these spans
// during preprocess and restore them after.
//
// Pattern detail:
//   \*\*       opening **
//   ([^*\n]*?  any non-`*`, non-newline chars, lazy
//     `[^`\n]+`   at least one `` `inline code` `` segment
//     [^*\n]*?)   then more non-`*` chars (lazy)
//   \*\*       closing **
//
// The lazy quantifiers keep us from spanning multiple bold groups.
const BOLD_AROUND_CODE_RE = /\*\*([^*\n]*?`[^`\n]+`[^*\n]*?)\*\*/g;

// Token used to placeholder `\|` escapes. Chosen so it's:
//   - ASCII letters/digits only (survives Tiptap's parse/serialize round trip)
//   - distinctive enough to never collide with real document content
const PIPE_ESCAPE_TOKEN = 'TIPTAPPIPEESCX';

/**
 * Decide whether a markdown inline link will be mangled by Tiptap, in
 * which case we should placeholder it during preprocess.
 *
 * Two failure modes are known:
 *
 *   1. Link text is purely inline code (`[\`x\`](url)`). tiptap-markdown
 *      drops the surrounding `[...](url)` and leaves just `\`x\``.
 *
 *   2. URL is a relative path with subdirectory but no leading prefix
 *      (`scripts/foo.mjs`, `references/output.md`). The Link extension's
 *      URL validator rejects these as non-URLs; the link is silently
 *      dropped on parse and the text alone survives.
 *
 * URLs Tiptap accepts and we leave alone:
 *   - Absolute URLs (`https://`, `http://`, `mailto:`, `tel:`, `ftp:`)
 *   - Anchors (`#section`)
 *   - Single-segment relative paths (`file.md`, `file.md#section`)
 *   - Explicitly-relative paths (`./foo`, `../foo`, `/foo`)
 */
function isFragileLink(text: string, url: string): boolean {
    // Code-text link: text is exactly `` `...` `` with nothing else.
    if (/^`[^`]+`$/.test(text)) return true;
    // URL has no scheme prefix and no leading-slash / relative-prefix
    // and contains at least one path separator → Tiptap rejects it.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
    const hasRelativePrefix = url.startsWith('./') || url.startsWith('../') || url.startsWith('/') || url.startsWith('#');
    if (!hasScheme && !hasRelativePrefix && url.includes('/')) return true;
    return false;
}

/**
 * Pre-process a document before handing it to Tiptap. Returns a context
 * object that `applyPostProcess` uses to restore stripped portions.
 */
export function preprocessForEditor(input: string): { editorInput: string; context: RoundTripContext } {
    const eol: '\r\n' | '\n' = input.includes('\r\n') ? '\r\n' : '\n';
    // Normalise to LF for the editor — Tiptap's parser doesn't reliably
    // preserve CRLF, and we'll re-introduce it on output.
    const lf = eol === '\r\n' ? input.replace(/\r\n/g, '\n') : input;

    const frontMatch = lf.match(FRONTMATTER_RE);
    const frontmatter = frontMatch ? frontMatch[0] : '';
    let afterFront = frontmatter ? lf.slice(frontmatter.length) : lf;

    // Capture leading blank lines that appeared AFTER the frontmatter so
    // we can put them back. Tiptap's parser strips them.
    const gap = afterFront.match(/^\n*/)?.[0] ?? '';
    afterFront = afterFront.slice(gap.length);

    const trailingNewline = afterFront.endsWith('\n') ? '\n' : '';

    // tiptap-markdown drops the URL on certain link shapes (see
    // isFragileLink — currently code-text links and bare-relative-subpath
    // links). Replace those with ASCII placeholders that survive the
    // parse-and-serialize round-trip unchanged; we restore them in
    // applyPostProcess.
    const codeLinks: Array<{ placeholder: string; original: string }> = [];
    let withPlaceholders = afterFront;
    let codeLinkIndex = 0;
    withPlaceholders = withPlaceholders.replace(INLINE_LINK_RE, (match, text, url) => {
        if (!isFragileLink(text, url)) return match;
        const placeholder = `TIPTAPCODELINK${String(codeLinkIndex).padStart(4, '0')}`;
        codeLinks.push({ placeholder, original: match });
        codeLinkIndex += 1;
        return placeholder;
    });

    // Bold spans containing inline code are restructured by Tiptap on
    // round-trip (the bold mark gets shifted around the code in ways
    // ProseMirror's flat-mark schema can express). Placeholder them
    // alongside fragile links — same trick, same restore pass.
    const boldCodeRuns: Array<{ placeholder: string; original: string }> = [];
    let boldCodeIndex = 0;
    withPlaceholders = withPlaceholders.replace(BOLD_AROUND_CODE_RE, (match) => {
        const placeholder = `TIPTAPBOLDCODE${String(boldCodeIndex).padStart(4, '0')}`;
        boldCodeRuns.push({ placeholder, original: match });
        boldCodeIndex += 1;
        return placeholder;
    });

    // Authors escape `|` as `\|` inside table cells when the cell
    // contains literal pipes (Mermaid edge labels in code, shell
    // pipelines, etc.) — bare `|` would split the cell. Tiptap's
    // serializer drops the backslash and the table re-parses with a
    // different shape next time. Replace with an ASCII token; restore
    // after serialize.
    let pipeEscapeCount = 0;
    withPlaceholders = withPlaceholders.replace(/\\\|/g, () => {
        pipeEscapeCount += 1;
        return PIPE_ESCAPE_TOKEN;
    });

    // Tiptap mutates trailing newlines — we trim and put it back. Wikilinks
    // are rewritten to a placeholder shape that survives Tiptap.
    const editorInput = rewriteWikiLinks(withPlaceholders);

    return {
        editorInput,
        context: {
            originalInput: input,
            frontmatter,
            frontmatterGap: gap,
            trailingNewline,
            eol,
            codeLinks,
            boldCodeRuns,
            pipeEscapeCount,
        },
    };
}

/**
 * Post-process the markdown Tiptap emits back into the user's expected
 * form: re-attach frontmatter, restore wikilink syntax, restore trailing
 * newline, undo unnecessary character escapes, and re-apply the original
 * EOL convention.
 */
export function applyPostProcess(serialized: string, context: RoundTripContext): string {
    let out = restoreWikiLinks(serialized);

    // Restore code-text links replaced with placeholders during preprocess.
    // Done before any other repair so subsequent text-shape fixups operate
    // on the original markdown form.
    for (const { placeholder, original } of context.codeLinks) {
        out = out.split(placeholder).join(original);
    }
    // Restore `**…\`code\`…**` placeholder runs alongside the link
    // restore — same shape, different schema-level reason for needing it.
    for (const { placeholder, original } of context.boldCodeRuns) {
        out = out.split(placeholder).join(original);
    }
    // Restore escaped pipe placeholders. Each token unconditionally maps
    // back to `\|` regardless of position — the user's escape is
    // syntactically required wherever it appears.
    if (context.pipeEscapeCount > 0) {
        out = out.split(PIPE_ESCAPE_TOKEN).join('\\|');
    }
    // Tiptap's serializer over-escapes characters that have no syntactic
    // meaning in the position they appear. We selectively unescape:
    //   - `\[` and `\]` outside link constructs (so `- [x] task` stays `- [x] task`)
    //   - `\~` (we already disabled strike, but tiptap-markdown's
    //     escape pass can still emit `\~` for any `~` it wasn't sure
    //     about — reverse it).
    // We do this with conservative regexes that don't touch valid escapes
    // inside fenced code blocks or inline code.
    out = unescapeSafeChars(out, context.originalInput);

    // Tiptap's HTML output path HTML-escapes bare `<` characters in
    // prose because they could in theory open a tag. tiptap-markdown
    // then serialises the entity as a literal `&lt;`. Reverse the
    // entity in positions where CommonMark says `<` could not have been
    // a tag opener (followed by space, digit, `$`, etc.) — preserves
    // the source bytes without changing parser interpretation.
    out = unescapeHtmlEntitiesInProse(out, context.originalInput);

    // Tiptap serialises CommonMark hard breaks (two trailing spaces in
    // the source) either as a `\` line-continuation or by dropping them
    // entirely (inside list items). Restore the original two-space form
    // wherever the source used it.
    out = restoreTrailingHardBreaks(out, context.originalInput);

    // Tiptap normalises GFM table separator rows to a spaced form
    // (`| --- | --- |`) regardless of input shape. If the original used
    // a more compact form (`|---|---|`), restore it line-by-line.
    out = restoreTableSeparatorStyle(out, context.originalInput);

    // tiptap-markdown is configured with `bulletListMarker: '-'` so every
    // bullet is emitted as `- `. If the source used `*` (or a mix), we'd
    // overwrite the user's preference on every save. Restore the original
    // marker by mapping output bullet lines onto their corresponding
    // source bullet lines positionally.
    out = restoreBulletMarkers(out, context.originalInput);

    // Tiptap inserts a leading blank line when the document starts with
    // a block element. Strip it so we can re-attach the original
    // post-frontmatter spacing exactly.
    out = out.replace(/^\n+/, '');

    // Tiptap (with `breaks: false`) joins consecutive non-blank lines
    // inside a paragraph with a space — that's CommonMark's soft-break
    // semantics. The user's source had them as separate lines, so the
    // file has been "modified" even though the visible content is the
    // same. Restore the original line breaks where Tiptap collapsed them.
    // This MUST run before collapseBlockSeparators because the latter
    // matches the surrounding lines against pairs from the original — and
    // those pairs are line-wise, not paragraph-wise.
    out = restoreSoftBreaks(out, context.originalInput);

    // Tiptap normalises block separators to a blank line. If the user
    // authored adjacent blocks with single-line separators, restore the
    // original single-line spacing.
    out = collapseBlockSeparators(out, context.originalInput);

    // Tiptap's serializer can leave its own trailing newline; normalise to
    // exactly the trailing-newline state the original had.
    out = out.replace(/\n+$/, '') + context.trailingNewline;

    // Re-attach frontmatter at the very top, with the original gap.
    if (context.frontmatter) {
        out = context.frontmatter + context.frontmatterGap + out;
    }

    // Apply original EOL convention.
    if (context.eol === '\r\n') {
        out = out.replace(/\n/g, '\r\n');
    }
    return out;
}

/**
 * Tiptap's table serializer always outputs separator rows in the spaced
 * form `| --- | --- |`. If the source document used a more compact form
 * (`|---|---|`), or any other consistent form, restore that style by
 * collecting the separator rows from the original and matching them
 * positionally to the separators in the output. Both forms are valid GFM
 * and parse identically — this is purely cosmetic and keeps autosave from
 * emitting one-line edit_block calls just because of whitespace.
 */
function restoreTableSeparatorStyle(serialized: string, originalInput: string): string {
    // Identify separator rows. A separator row matches /^\|([:\-\s|]+)\|$/
    // — only `:`, `-`, `|`, and whitespace.
    const SEP_RE = /^\|[\s:\-|]+\|$/;
    const origSeparators = originalInput
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => SEP_RE.test(line));
    if (origSeparators.length === 0) return serialized;

    const outLines = serialized.split('\n');
    let sepIndex = 0;
    for (let i = 0; i < outLines.length; i += 1) {
        if (SEP_RE.test(outLines[i]) && sepIndex < origSeparators.length) {
            // Confirm the column count matches before substituting; if it
            // doesn't, the table has been edited and we leave the new
            // form alone (otherwise we'd corrupt the user's structural
            // changes).
            const origCols = origSeparators[sepIndex].split('|').length;
            const outCols = outLines[i].split('|').length;
            if (origCols === outCols) {
                outLines[i] = origSeparators[sepIndex];
            }
            sepIndex += 1;
        }
    }
    return outLines.join('\n');
}

/**
 * Restore the user's original bullet-list marker style.
 *
 * tiptap-markdown's serializer has a single `bulletListMarker` config
 * (we set it to `-`). That means a source file written with `*` bullets
 * comes back with `-` bullets — no data loss, but the file diff is full
 * of one-character changes the user didn't make.
 *
 * Strategy: collect every "bullet line" from the original (lines starting
 * with optional indent + `*`/`-`/`+` + space), in order. Walk the output;
 * for each bullet line, restore the marker style at the same ordinal
 * position. If the structure shifted (the user added a bullet that wasn't
 * in the source), trailing extra bullets keep the editor's `-` style —
 * that's correct for new content.
 */
function restoreBulletMarkers(serialized: string, originalInput: string): string {
    const BULLET_RE = /^(\s*)([*\-+])(\s)/;
    const origLines = originalInput.replace(/\r\n/g, '\n').split('\n');
    // Collect markers in source order. We index purely by position in
    // the bullet sequence — no attempt to match by content, so re-ordered
    // bullets still get sensible markers.
    const origMarkers: string[] = [];
    for (const line of origLines) {
        const m = line.match(BULLET_RE);
        if (m) origMarkers.push(m[2]);
    }
    if (origMarkers.length === 0) return serialized;

    const outLines = serialized.split('\n');
    let bulletIdx = 0;
    for (let i = 0; i < outLines.length; i += 1) {
        const m = outLines[i].match(BULLET_RE);
        if (!m) continue;
        const wanted = origMarkers[bulletIdx];
        if (wanted && wanted !== m[2]) {
            outLines[i] = m[1] + wanted + m[3] + outLines[i].slice(m[0].length);
        }
        bulletIdx += 1;
    }
    return outLines.join('\n');
}

/**
 * Restore soft line-breaks Tiptap collapsed.
 *
 * tiptap-markdown is configured with `breaks: false`, which matches
 * CommonMark's default: a single newline inside a paragraph is treated as
 * a soft break and rendered/serialised as a single space. So an input of
 *
 *   First line.
 *   Second line.
 *
 * comes back as `First line. Second line.` — same visible content, but
 * the file on disk now differs from what the user authored. This function
 * walks pairs of adjacent non-blank lines from the original and, where
 * Tiptap joined them with a space, restores the original line break.
 *
 * Limitations: if the user actually had `First line. Second line.` on a
 * single line in the source, we won't break it (we only re-introduce
 * breaks that existed in the source). If the same `A` line appears
 * multiple times in the source followed by different `B` lines, we
 * conservatively only repair the FIRST match — the rest are left as
 * Tiptap emitted them (rare in practice).
 */
function restoreSoftBreaks(serialized: string, originalInput: string): string {
    const origLines = originalInput.replace(/\r\n/g, '\n').split('\n');
    let out = serialized;
    for (let i = 0; i < origLines.length - 1; i += 1) {
        const a = origLines[i];
        const b = origLines[i + 1];
        // Only consider pairs where BOTH lines are non-blank prose. A
        // blank line means the pair was paragraph-separated, which Tiptap
        // already serialises as `\n\n` — handled elsewhere.
        if (!a || !b) continue;
        // Skip lines that look like markdown structure: list markers,
        // headings, fences, table rows, blockquotes. Tiptap handles those
        // as their own block kinds; we don't want to break list items in
        // half — EXCEPT for the specific case of a list item followed by
        // its 2-space-indented lazy continuation. CommonMark joins those
        // into one paragraph too, and Tiptap collapses them into a single
        // line. The source authored them as separate lines so we must
        // restore the break.
        const aIsListHeader = /^\s*([-*+]|\d+\.)\s/.test(a);
        const bIsIndentedCont = /^  +\S/.test(b) && !/^\s*([-*+]|\d+\.)\s/.test(b);
        const isListContinuation = aIsListHeader && bIsIndentedCont;
        if (!isListContinuation) {
            if (looksStructural(a) || looksStructural(b)) continue;
        }
        const broken = `${a}\n${b}`;
        if (out.indexOf(broken) !== -1) continue;
        // Tiptap joins paragraph-internal lines with EITHER a space (the
        // common case for prose) OR no separator at all (when the
        // boundary is between punctuation like `)` and a non-letter
        // character like an emoji). For list-item lazy continuations,
        // Tiptap STRIPS the leading whitespace from the second line and
        // then joins with a single space, so we have to compare against
        // the de-indented form of `b`.
        const candidates: Array<{ joiner: string; b: string }> = [
            { joiner: ' ', b },
            { joiner: '', b },
        ];
        if (isListContinuation) {
            const deindented = b.replace(/^\s+/, '');
            candidates.push({ joiner: ' ', b: deindented });
        }
        for (const { joiner, b: bForm } of candidates) {
            const joined = `${a}${joiner}${bForm}`;
            const idx = out.indexOf(joined);
            if (idx === -1) continue;
            out = out.slice(0, idx) + broken + out.slice(idx + joined.length);
            break;
        }
    }
    return out;
}

/**
 * Heuristic: does this line look like markdown structure (heading, list,
 * fence, table, blockquote) rather than plain prose? Used by
 * restoreSoftBreaks to avoid mangling structural content.
 */
function looksStructural(line: string): boolean {
    return /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|\s*$|---|\s*$)/.test(line);
}

/**
 * Unescape characters that tiptap-markdown's serializer over-escapes.
 * We only undo escapes for characters that are NEVER syntactically active
 * in plain prose: brackets in body text, tildes outside strikethrough,
 * etc.
 *
 * Round-trip safety: only undo an escape if the SAME escape was not
 * already present in the original source. If the user's file had `\~190M`
 * literally (e.g. left over from a previous Tiptap save before we
 * disabled strike), we leave it alone. If the editor introduced a NEW
 * escape that wasn't in the source, we remove it. This preserves the
 * file-on-disk vs. cleaning-up tension on the safe side.
 *
 * Code fences are skipped so language-internal escapes survive.
 */
function unescapeSafeChars(md: string, originalInput: string): string {
    // The fix is per-line, not per-document. For each output line, find a
    // matching source line by stripping all `\X` escapes from candidates;
    // if a stripped source line equals the output line (after also
    // stripping the same escapes), the user did NOT author those escapes
    // in this region and we may safely remove them. If no source line
    // matches even after stripping, we err on the safe side and keep the
    // escapes (they may be intentional).
    const origLines = originalInput.replace(/\r\n/g, '\n').split('\n');

    let insideFence = false;
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
            insideFence = !insideFence;
            continue;
        }
        if (insideFence) continue;

        // Quick check: if no candidate escapes are even present in this
        // output line, nothing to do.
        if (!/\\[\[\]~]/.test(line)) continue;

        const stripped = stripSafeEscapes(line);
        // Does ANY source line match this output line, with both sides
        // stripped of safe escapes? If yes, the source had this content
        // without those escapes, so Tiptap added them — strip them.
        const sourceHasEquivalent = origLines.some((origLine) => stripSafeEscapes(origLine) === stripped);
        if (sourceHasEquivalent) {
            // Look for an exact source line match (escapes intact). If
            // there's an exact match, use it to know which escapes were
            // authored vs added.
            const exact = origLines.find((origLine) => origLine === line);
            if (exact !== undefined) {
                // Source had this exact line including escapes — preserve.
                continue;
            }
            // Source had the equivalent without authoring these escapes —
            // strip them.
            lines[i] = stripped;
        }
        // Otherwise: source line is genuinely different from output. Could
        // be an edit, could be a region we don't have a per-line match
        // for. Leave the escapes alone — round-trip safety wins over
        // cleanup.
    }
    return lines.join('\n');
}

/**
 * Remove the safe-escape prefixes (`\[`, `\]`, `\~`) from a line. Used to
 * compare an output line against source lines after both have been
 * normalised — if they then match, neither side had user-authored escapes
 * for these specific characters.
 */
function stripSafeEscapes(line: string): string {
    return line.replace(/\\([\[\]~])/g, '$1');
}

/**
 * Replace `&lt;` / `&gt;` / `&amp;` HTML entities with their literal
 * characters in positions where they cannot be HTML or markdown syntax.
 *
 * Tiptap's HTML output path escapes bare `<` and `&` in prose because
 * the characters could in theory open a tag or entity. tiptap-markdown
 * then serialises those entities verbatim, so a source like `< $0.01`
 * round-trips as `&lt; $0.01`. We undo the escape only when the
 * surrounding context proves it can't be markup:
 *
 *   - `&lt;` followed by space, digit, `$`, end-of-line, or a punctuation
 *     character that can't begin an HTML tag name.
 *   - `&gt;` likewise; in CommonMark `>` only has block-level meaning at
 *     the start of a line (blockquote), and we never produce that here.
 *   - `&amp;` always — `&` followed by anything that isn't a known entity
 *     prefix wouldn't survive parsing as a real entity anyway.
 *
 * Code fences and inline code are skipped so that intentionally-escaped
 * entities inside code samples are left intact.
 *
 * Round-trip safety: if the same entity appears in the source on a
 * matching line, we leave it alone (the user authored the entity and we
 * mustn't strip it). This mirrors the line-aligned rule in
 * unescapeSafeChars.
 */
function unescapeHtmlEntitiesInProse(md: string, originalInput: string): string {
    const origLines = originalInput.replace(/\r\n/g, '\n').split('\n');
    let insideFence = false;
    const lines = md.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
            insideFence = !insideFence;
            continue;
        }
        if (insideFence) continue;
        if (!/&(?:lt|gt|amp);/.test(line)) continue;

        // Only act if there's a source line that, when both are stripped
        // of these specific entities, matches this output line. Otherwise
        // we don't have enough confidence the entity was Tiptap's doing.
        const stripped = stripHtmlEntities(line);
        const sourceMatches = origLines.some((src) => stripHtmlEntities(src) === stripped);
        if (!sourceMatches) continue;

        const exact = origLines.find((src) => src === line);
        if (exact !== undefined) {
            // Source had this exact line including entities — preserve.
            continue;
        }
        // Otherwise the source had the equivalent without entities;
        // Tiptap added them — strip.
        lines[i] = stripped;
    }
    return lines.join('\n');
}

function stripHtmlEntities(line: string): string {
    // Conservative replacements — only the three Tiptap actually emits.
    return line
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * Restore CommonMark hard-break syntax (two trailing spaces at end of
 * line) where Tiptap stripped or rewrote it.
 *
 * Tiptap's serializer represents a hard break either as `\` followed by
 * a newline (paragraphs) or by silently dropping it (list items). The
 * source convention is two trailing spaces; we honour the source.
 *
 * Strategy: collect every source line that ends in `  ` (exactly two
 * spaces). For each, find a matching output line — either:
 *   - same content with no trailing whitespace (the dropped case), or
 *   - same content followed by `\\` line continuation (the rewritten
 *     case — `expand left\\\nleft`).
 * Replace with the source's two-space form.
 */
function restoreTrailingHardBreaks(serialized: string, originalInput: string): string {
    const origLines = originalInput.replace(/\r\n/g, '\n').split('\n');
    // Lines that ended in exactly two trailing spaces — paired with
    // their content sans the trailing spaces, for cheap matching.
    const hardBreakSources: string[] = [];
    for (const line of origLines) {
        if (/[^ ]  $/.test(line)) {
            hardBreakSources.push(line.slice(0, -2));
        }
    }
    if (hardBreakSources.length === 0) return serialized;

    let out = serialized;
    for (const stem of hardBreakSources) {
        // Case 1: paragraph hard break — `stem\\\nNEXT` → `stem  \nNEXT`.
        const backslashForm = `${stem}\\\n`;
        if (out.includes(backslashForm)) {
            out = out.replace(backslashForm, `${stem}  \n`);
            continue;
        }
        // Case 2: silently dropped (list-item case). Look for the bare
        // `stem\n` and re-introduce the two trailing spaces. We only
        // repair the FIRST match — adding a hard break to the wrong
        // duplicate is worse than missing one.
        const bareForm = `${stem}\n`;
        const idx = out.indexOf(bareForm);
        if (idx !== -1) {
            out = out.slice(0, idx) + `${stem}  \n` + out.slice(idx + bareForm.length);
        }
    }
    return out;
}

/**
 * If the user's original document used single-line separators between
 * adjacent block elements (e.g. `### A\nBody.\n### B\n`), Tiptap will
 * normalise those to blank-line separators (`\n\n`). Compare structure
 * pairwise and put back the original spacing wherever Tiptap diverged.
 *
 * This is a "best effort" fixup: it doesn't try to rewrite content, only
 * to remove spurious blank lines that Tiptap injected between block
 * elements that were adjacent in the source.
 */
function collapseBlockSeparators(serialized: string, originalInput: string): string {
    // Tokenise both into "block" units separated by blank-line vs single-
    // newline boundaries. If the original had no blank line between two
    // adjacent block lines that match (heading -> body, body -> heading,
    // etc.), strip the blank line Tiptap inserted between the same pair.
    const origLines = originalInput.replace(/\r\n/g, '\n').split('\n');
    const adjacentPairs = new Set<string>();
    for (let i = 0; i < origLines.length - 1; i += 1) {
        const a = origLines[i];
        const b = origLines[i + 1];
        if (a && b) {
            // Both non-empty consecutive lines — adjacent in the original.
            adjacentPairs.add(`${a}\u0001${b}`);
        }
    }

    const outLines = serialized.split('\n');
    const result: string[] = [];
    for (let i = 0; i < outLines.length; i += 1) {
        const cur = outLines[i];
        // If this is a blank line and the lines around it were adjacent
        // in the original, drop the blank.
        if (cur === '' && i > 0 && i < outLines.length - 1) {
            const prev = outLines[i - 1];
            const next = outLines[i + 1];
            if (prev && next && adjacentPairs.has(`${prev}\u0001${next}`)) {
                continue;
            }
        }
        result.push(cur);
    }
    return result.join('\n');
}

/**
 * Build the Tiptap extension array used by both production and the test
 * suite. Centralising this means the regression tests exercise the exact
 * configuration that ships, so any fix here flows through to autosave too.
 *
 * Notable choices:
 *   - StarterKit's strike extension is DISABLED. The default behaviour
 *     escapes literal `~` to `\~` (and breaks `~/path`) on serialize,
 *     because tiptap-markdown configures markdown-it with the strike
 *     plugin enabled, which in turn enables `~` as an escape target.
 *     Disabling strike costs us nothing visible (the editor never offered
 *     a strike button) and unblocks two #440 corruption modes.
 */
export function buildTiptapExtensions(): Extensions {
    return [
        StarterKit.configure({
            heading: { levels: [1, 2, 3, 4, 5, 6] },
            codeBlock: { HTMLAttributes: { class: 'code-viewer' } },
            link: {
                openOnClick: false,
                autolink: true,
                HTMLAttributes: { 'data-markdown-link': 'true' },
            },
            // Disable strikethrough — see comment above. The serializer
            // would otherwise treat `~` as a strike delimiter character
            // and emit `\~` to escape it.
            strike: false,
        }),
        Image.configure({ allowBase64: true, inline: true }),
        // GFM pipe table support. Without these four extensions Tiptap's
        // parser sees `| A | B |` rows as plain paragraphs and concatenates
        // the cell text — the canonical #437 corruption pattern. With them,
        // tiptap-markdown round-trips tables correctly.
        Table.configure({ resizable: false, HTMLAttributes: { class: 'markdown-table' } }),
        TableRow,
        TableHeader,
        TableCell,
        Markdown.configure({
            html: true,
            tightLists: true,
            bulletListMarker: '-',
            // `linkify: true` made tiptap-markdown auto-wrap bare URLs in
            // <…> autolink brackets on serialize, even when the source had
            // them as bare URLs. The editor still recognises pasted URLs
            // as clickable via Tiptap's link extension; this only affects
            // the parser's "treat any URL-shaped string as a Link node"
            // behaviour, which is what was rewriting `https://...` to
            // `<https://...>` on round-trip.
            linkify: false,
            breaks: false,
            transformPastedText: true,
            transformCopiedText: false,
        }),
    ];
}

/**
 * Convenience wrapper for tests and tools that want to mount the editor,
 * call getMarkdown(), tear down, all in one shot. Production uses the
 * pieces individually (preprocessForEditor at mount time, getMarkdown
 * during autosave, applyPostProcess before writing to disk).
 */
export function roundTripMarkdown(input: string): string {
    const { editorInput, context } = preprocessForEditor(input);
    const target = document.createElement('div');
    const editor = new Editor({
        element: target,
        extensions: buildTiptapExtensions(),
        content: editorInput,
    });
    const storage = editor.storage as { markdown?: { getMarkdown: () => string } };
    const serialized = storage.markdown?.getMarkdown() ?? '';
    editor.destroy();
    return applyPostProcess(serialized, context);
}

export interface MarkdownLinkSearchItem {
    path: string;
    title: string;
    wikiPath: string;
    relativePath: string;
}

export interface MarkdownLinkHeading {
    id: string;
    text: string;
}

export interface MarkdownEditorHandle {
    destroy: () => void;
    focus: () => void;
    getValue: () => string;
    setValue: (value: string) => void;
    revealLine: (lineNumber: number, headingId?: string) => void;
    setScrollTop: (scrollTop: number) => void;
}

export interface MarkdownEditRange {
    fromLine: number;
    toLine: number;
}

function computeSerializedEditRanges(before: string, after: string): MarkdownEditRange[] {
    if (before === after) {
        return [];
    }

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const beforeLength = beforeLines.length;
    const afterLength = afterLines.length;
    const ranges: MarkdownEditRange[] = [];

    if (beforeLength * afterLength > 1_000_000) {
        return computeAnchoredSerializedEditRanges(beforeLines, afterLines, 0, beforeLength, 0, afterLength);
    }

    const dp: number[][] = Array.from({ length: beforeLength + 1 }, () => Array(afterLength + 1).fill(0) as number[]);
    for (let beforeIndex = 1; beforeIndex <= beforeLength; beforeIndex += 1) {
        for (let afterIndex = 1; afterIndex <= afterLength; afterIndex += 1) {
            dp[beforeIndex][afterIndex] = beforeLines[beforeIndex - 1] === afterLines[afterIndex - 1]
                ? dp[beforeIndex - 1][afterIndex - 1] + 1
                : Math.max(dp[beforeIndex - 1][afterIndex], dp[beforeIndex][afterIndex - 1]);
        }
    }

    const matches: Array<[number, number]> = [];
    let beforeIndex = beforeLength;
    let afterIndex = afterLength;
    while (beforeIndex > 0 && afterIndex > 0) {
        if (beforeLines[beforeIndex - 1] === afterLines[afterIndex - 1]) {
            matches.unshift([beforeIndex - 1, afterIndex - 1]);
            beforeIndex -= 1;
            afterIndex -= 1;
        } else if (dp[beforeIndex - 1][afterIndex] >= dp[beforeIndex][afterIndex - 1]) {
            beforeIndex -= 1;
        } else {
            afterIndex -= 1;
        }
    }

    let previousBefore = 0;
    let previousAfter = 0;
    for (const [matchBefore, matchAfter] of matches) {
        if (matchBefore > previousBefore || matchAfter > previousAfter) {
            ranges.push({ fromLine: Math.max(1, previousAfter - 3), toLine: Math.max(previousAfter + 1, matchAfter + 3) });
        }
        previousBefore = matchBefore + 1;
        previousAfter = matchAfter + 1;
    }
    if (previousBefore < beforeLength || previousAfter < afterLength) {
        ranges.push({ fromLine: Math.max(1, previousAfter - 3), toLine: Math.max(previousAfter + 1, afterLength + 3) });
    }

    return ranges;
}

function computeAnchoredSerializedEditRanges(
    beforeLines: string[],
    afterLines: string[],
    beforeStart: number,
    beforeEnd: number,
    afterStart: number,
    afterEnd: number
): MarkdownEditRange[] {
    while (beforeStart < beforeEnd && afterStart < afterEnd && beforeLines[beforeStart] === afterLines[afterStart]) {
        beforeStart++;
        afterStart++;
    }
    while (beforeStart < beforeEnd && afterStart < afterEnd && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
        beforeEnd--;
        afterEnd--;
    }
    if (beforeStart === beforeEnd && afterStart === afterEnd) {
        return [];
    }

    const beforeLineCounts = new Map<string, { count: number; index: number }>();
    const afterLineCounts = new Map<string, { count: number; index: number }>();
    for (let index = beforeStart; index < beforeEnd; index += 1) {
        const current = beforeLineCounts.get(beforeLines[index]);
        beforeLineCounts.set(beforeLines[index], { count: (current?.count ?? 0) + 1, index });
    }
    for (let index = afterStart; index < afterEnd; index += 1) {
        const current = afterLineCounts.get(afterLines[index]);
        afterLineCounts.set(afterLines[index], { count: (current?.count ?? 0) + 1, index });
    }

    for (let beforeIndex = beforeStart; beforeIndex < beforeEnd; beforeIndex += 1) {
        const beforeEntry = beforeLineCounts.get(beforeLines[beforeIndex]);
        const afterEntry = afterLineCounts.get(beforeLines[beforeIndex]);
        if (beforeEntry?.count === 1 && afterEntry?.count === 1) {
            return [
                ...computeAnchoredSerializedEditRanges(beforeLines, afterLines, beforeStart, beforeIndex, afterStart, afterEntry.index),
                ...computeAnchoredSerializedEditRanges(beforeLines, afterLines, beforeIndex + 1, beforeEnd, afterEntry.index + 1, afterEnd),
            ];
        }
    }

    return [{
        fromLine: Math.max(1, afterStart - 3),
        toLine: Math.max(afterStart + 1, afterEnd + 3),
    }];
}

function shouldIgnoreBlur(shell: Element | null | undefined, event: FocusEvent): boolean {
    const nextTarget = event.relatedTarget as Node | null;
    const widgetShell = shell?.closest('.tool-shell');
    return Boolean(nextTarget && (shell?.contains(nextTarget) || widgetShell?.contains(nextTarget)));
}

function renderFormattingButtons(): string {
    return `
      <button class="markdown-format-button" type="button" data-format="bold"><strong>B</strong></button>
      <button class="markdown-format-button" type="button" data-format="italic"><em>I</em></button>
      <button class="markdown-format-button" type="button" data-format="strike"><span style="text-decoration:line-through">S</span></button>
      <span class="markdown-format-sep" aria-hidden="true"></span>
      <label class="markdown-format-size" title="Block style" aria-label="Block style">
        <select id="markdown-block-style">
          <option value="p" selected>Normal</option>
          <option value="h1">H1</option>
          <option value="h2">H2</option>
          <option value="h3">H3</option>
        </select>
      </label>
      <span class="markdown-format-sep" aria-hidden="true"></span>
      <button class="markdown-format-button" type="button" data-format="quote" title="Quote" aria-label="Quote">&#10077;</button>
      <button class="markdown-format-button" type="button" data-format="list" title="List" aria-label="List">&#8226;</button>
      <button class="markdown-format-button" type="button" data-format="link" title="Link" aria-label="Link">&#128279;</button>
      <button class="markdown-format-button" type="button" data-format="code" title="Code" aria-label="Code">&lsaquo;&rsaquo;</button>
    `;
}

function renderModeToggleIcon(view: MarkdownEditorView): string {
    if (view === 'raw') {
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>';
    }

    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M4 12h10"></path><path d="M4 17h7"></path></svg>';
}

function renderHeadingOptionLabel(headings: MarkdownLinkHeading[], heading: MarkdownLinkHeading): string {
    const duplicateCount = headings.filter((candidate) => candidate.text === heading.text).length;
    if (duplicateCount <= 1) {
        return heading.text;
    }

    return `${heading.text} (#${heading.id})`;
}

export function renderMarkdownCopyButton(): string {
    return `<button class="markdown-editor-copy-button" type="button" id="copy-active-markdown" title="Copy" aria-label="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button>`;
}

export function renderMarkdownModeToggle(view: MarkdownEditorView): string {
    return `
      <div class="markdown-editor-mode-toggle" role="tablist" aria-label="Editor mode">
        <div class="markdown-editor-mode-toggle-indicator markdown-editor-mode-toggle-indicator--${view}" aria-hidden="true"></div>
        <button class="markdown-editor-mode-option${view === 'raw' ? ' is-active' : ''}" type="button" id="markdown-mode-raw" role="tab" aria-selected="${view === 'raw' ? 'true' : 'false'}" title="Raw" aria-label="Raw">${renderModeToggleIcon('raw')}<span>Raw</span></button>
        <button class="markdown-editor-mode-option${view === 'markdown' ? ' is-active' : ''}" type="button" id="markdown-mode-markdown" role="tab" aria-selected="${view === 'markdown' ? 'true' : 'false'}" title="Preview" aria-label="Preview">${renderModeToggleIcon('markdown')}<span>Preview</span></button>
      </div>
    `;
}

export function renderMarkdownEditorShell(options: {
    view: MarkdownEditorView;
}): string {
    const isMarkdownView = options.view === 'markdown';

    return `
      <div class="markdown-editor-shell markdown-editor-shell--${options.view}">
        <section class="markdown-editor-pane markdown-editor-pane--${options.view}" aria-label="Markdown editor">
          ${isMarkdownView ? `<div id="markdown-editor-context-menu" class="markdown-editor-context-menu" hidden>${renderFormattingButtons()}</div><div id="markdown-link-modal" class="markdown-link-modal" hidden><div class="markdown-link-modal-card"><div class="markdown-link-mode-tabs"><button type="button" id="markdown-link-mode-file" class="markdown-link-mode-tab is-active">File</button><button type="button" id="markdown-link-mode-url" class="markdown-link-mode-tab">URL</button></div><div id="markdown-link-file-fields"><label class="markdown-link-modal-label" for="markdown-link-search">Find note</label><input id="markdown-link-search" class="markdown-link-modal-input" type="text" placeholder="Search files..." /><div id="markdown-link-results" class="markdown-link-results"></div><label class="markdown-link-modal-label" for="markdown-link-heading">Heading</label><select id="markdown-link-heading" class="markdown-link-modal-input markdown-link-modal-select"><option value="">None</option></select><label class="markdown-link-modal-label" for="markdown-link-alias">Alias</label><input id="markdown-link-alias" class="markdown-link-modal-input" type="text" placeholder="Optional label" /></div><div id="markdown-link-url-fields" hidden><label class="markdown-link-modal-label" for="markdown-link-input">URL</label><input id="markdown-link-input" class="markdown-link-modal-input" type="url" placeholder="https://example.com" /><label class="markdown-link-modal-label" for="markdown-link-label">Label</label><input id="markdown-link-label" class="markdown-link-modal-input" type="text" placeholder="Optional label" /></div><div class="markdown-link-modal-actions"><button type="button" id="markdown-link-cancel" class="markdown-link-modal-button">Cancel</button><button type="button" id="markdown-link-apply" class="markdown-link-modal-button markdown-link-modal-button--primary">Insert</button></div></div></div>` : ''}
          <div id="markdown-editor-root" class="markdown-editor-root"></div>
        </section>
      </div>
    `;
}

function applyRawTab(textarea: HTMLTextAreaElement): void {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextValue = `${textarea.value.slice(0, start)}\t${textarea.value.slice(end)}`;
    textarea.value = nextValue;
    textarea.selectionStart = start + 1;
    textarea.selectionEnd = start + 1;
}

/**
 * Walk the prose-mirror DOM and assign slug-based id attributes to headings
 * so the outline's revealLine can scroll to them. Re-run after every update;
 * no-op writes are skipped so identical ids don't dirty the style engine.
 */
function syncHeadingIds(root: HTMLElement): void {
    const nextSlug = createSlugTracker();
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
    for (const heading of headings) {
        const text = heading.textContent?.trim() ?? '';
        if (!text) {
            if (heading.hasAttribute('id')) {
                heading.removeAttribute('id');
            }
            if (heading.hasAttribute('data-heading-id')) {
                heading.removeAttribute('data-heading-id');
            }
            continue;
        }
        const headingId = nextSlug(text);
        if (heading.id !== headingId) {
            heading.id = headingId;
        }
        if (heading.getAttribute('data-heading-id') !== headingId) {
            heading.setAttribute('data-heading-id', headingId);
        }
    }
}

export function mountMarkdownEditor(options: {
    target: HTMLElement;
    value: string;
    view: MarkdownEditorView;
    initialScrollTop?: number;
    currentFilePath: string;
    searchLinks?: (query: string) => Promise<MarkdownLinkSearchItem[]>;
    loadHeadings?: (filePath: string) => Promise<MarkdownLinkHeading[]>;
    onChange: (value: string, editRanges?: MarkdownEditRange[]) => void;
    onBlur?: () => void;
}): MarkdownEditorHandle {
    const shell = options.target.closest('.markdown-editor-shell');
    const contextMenu = shell?.querySelector('#markdown-editor-context-menu') as HTMLElement | null;
    const formatButtons = shell ? Array.from(shell.querySelectorAll<HTMLButtonElement>('[data-format]')) : [];
    const blockStyleSelect = shell?.querySelector('#markdown-block-style') as HTMLSelectElement | null;
    const linkModal = shell?.querySelector('#markdown-link-modal') as HTMLElement | null;
    const linkModeFile = shell?.querySelector('#markdown-link-mode-file') as HTMLButtonElement | null;
    const linkModeUrl = shell?.querySelector('#markdown-link-mode-url') as HTMLButtonElement | null;
    const linkFileFields = shell?.querySelector('#markdown-link-file-fields') as HTMLElement | null;
    const linkUrlFields = shell?.querySelector('#markdown-link-url-fields') as HTMLElement | null;
    const linkSearchInput = shell?.querySelector('#markdown-link-search') as HTMLInputElement | null;
    const linkResults = shell?.querySelector('#markdown-link-results') as HTMLElement | null;
    const linkHeadingSelect = shell?.querySelector('#markdown-link-heading') as HTMLSelectElement | null;
    const linkAliasInput = shell?.querySelector('#markdown-link-alias') as HTMLInputElement | null;
    const linkInput = shell?.querySelector('#markdown-link-input') as HTMLInputElement | null;
    const linkLabelInput = shell?.querySelector('#markdown-link-label') as HTMLInputElement | null;
    const linkApply = shell?.querySelector('#markdown-link-apply') as HTMLButtonElement | null;
    const linkCancel = shell?.querySelector('#markdown-link-cancel') as HTMLButtonElement | null;
    let linkMode: 'file' | 'url' = 'file';
    let linkSearchResults: MarkdownLinkSearchItem[] = [];
    let selectedLinkItem: MarkdownLinkSearchItem | null = null;
    let linkResultsMessage = 'Search for a file to link';
    let linkSearchRequestId = 0;
    let linkHeadingRequestId = 0;

    if (options.view === 'markdown') {
        options.target.replaceChildren();
        let hasUserEdited = false;
        const markUserEdit = (): void => {
            hasUserEdited = true;
        };

        // Pre-process the input once at mount; the captured context is
        // mirrored back into output by getTiptapMarkdown so trailing
        // newline / frontmatter / EOL are preserved.
        const { editorInput, context } = preprocessForEditor(options.value);

        const getTiptapMarkdown = (): string => {
            const storage = tiptap.storage as { markdown?: { getMarkdown: () => string } };
            const serialized = storage.markdown?.getMarkdown() ?? '';
            return applyPostProcess(serialized, context);
        };
        let previousSerializedValue = '';

        const tiptap = new Editor({
            element: options.target,
            extensions: buildTiptapExtensions(),
            content: editorInput,
            editorProps: {
                attributes: {
                    class: 'markdown-editor-surface markdown-editor-surface--markdown markdown markdown-doc',
                    role: 'textbox',
                    'aria-multiline': 'true',
                },
            },
            onUpdate: ({ editor }) => {
                syncHeadingIds(editor.view.dom as HTMLElement);
                if (!hasUserEdited) {
                    return;
                }
                const value = getTiptapMarkdown();
                const editRanges = computeSerializedEditRanges(previousSerializedValue, value);
                previousSerializedValue = value;
                options.onChange(value, editRanges);
            },
            onSelectionUpdate: () => {
                updateContextMenu();
            },
            onBlur: ({ event }) => {
                if (shouldIgnoreBlur(shell, event as FocusEvent)) {
                    return;
                }
                if (contextMenu) {
                    contextMenu.hidden = true;
                }
                options.onBlur?.();
            },
        });
        previousSerializedValue = getTiptapMarkdown();

        const editorDom = tiptap.view.dom as HTMLElement;
        syncHeadingIds(editorDom);

        const updateContextMenu = (): void => {
            if (!contextMenu) {
                return;
            }
            const { from, to, empty } = tiptap.state.selection;
            if (empty || !tiptap.isFocused) {
                contextMenu.hidden = true;
                return;
            }
            const start = tiptap.view.coordsAtPos(from);
            const end = tiptap.view.coordsAtPos(to);
            const shellEl = shell as HTMLElement | null;
            if (!shellEl) {
                return;
            }
            const shellRect = shellEl.getBoundingClientRect();
            const midX = (start.left + end.right) / 2;
            contextMenu.hidden = false;
            const left = Math.max(12, midX - shellRect.left - contextMenu.offsetWidth / 2);
            const top = Math.max(12, start.top - shellRect.top - contextMenu.offsetHeight - 10);
            contextMenu.style.left = `${left}px`;
            contextMenu.style.top = `${top}px`;
        };

        const setLinkHeadingOptions = (headings: MarkdownLinkHeading[] = [], placeholder: string = 'None'): void => {
            if (!linkHeadingSelect) {
                return;
            }
            linkHeadingSelect.replaceChildren();
            const noneOption = document.createElement('option');
            noneOption.value = '';
            noneOption.textContent = placeholder;
            linkHeadingSelect.appendChild(noneOption);
            for (const heading of headings) {
                const option = document.createElement('option');
                option.value = heading.id;
                option.textContent = renderHeadingOptionLabel(headings, heading);
                option.dataset.headingText = heading.text;
                linkHeadingSelect.appendChild(option);
            }
        };

        const loadHeadingsForItem = async (item: MarkdownLinkSearchItem): Promise<void> => {
            if (!linkHeadingSelect) {
                return;
            }
            const requestId = ++linkHeadingRequestId;
            setLinkHeadingOptions([], 'Loading…');
            try {
                const headings = await options.loadHeadings?.(item.path) ?? [];
                if (requestId !== linkHeadingRequestId || selectedLinkItem?.path !== item.path) {
                    return;
                }
                setLinkHeadingOptions(headings);
            } catch {
                if (requestId !== linkHeadingRequestId || selectedLinkItem?.path !== item.path) {
                    return;
                }
                setLinkHeadingOptions([], 'Failed to load headings');
            }
        };

        const renderLinkResults = (): void => {
            if (!linkResults) {
                return;
            }
            if (linkSearchResults.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'markdown-link-results-empty';
                empty.textContent = linkResultsMessage;
                linkResults.replaceChildren(empty);
                return;
            }
            const fragment = document.createDocumentFragment();
            for (const item of linkSearchResults) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `markdown-link-result${selectedLinkItem?.path === item.path ? ' is-active' : ''}`;
                button.dataset.linkPath = item.path;

                const title = document.createElement('span');
                title.className = 'markdown-link-result-title';
                title.textContent = item.title;

                const path = document.createElement('span');
                path.className = 'markdown-link-result-path';
                path.textContent = item.relativePath;

                button.append(title, path);
                button.addEventListener('click', () => {
                    selectedLinkItem = item;
                    renderLinkResults();
                    void loadHeadingsForItem(item);
                });
                fragment.appendChild(button);
            }
            linkResults.replaceChildren(fragment);
        };

        const updateLinkMode = (mode: 'file' | 'url'): void => {
            linkMode = mode;
            linkModeFile?.classList.toggle('is-active', mode === 'file');
            linkModeUrl?.classList.toggle('is-active', mode === 'url');
            if (linkFileFields) {
                linkFileFields.hidden = mode !== 'file';
            }
            if (linkUrlFields) {
                linkUrlFields.hidden = mode !== 'url';
            }
        };

        const runLinkSearch = async (): Promise<void> => {
            if (!linkSearchInput || !options.searchLinks) {
                return;
            }
            const query = linkSearchInput.value.trim();
            if (query.length === 0) {
                linkSearchRequestId += 1;
                linkSearchResults = [];
                selectedLinkItem = null;
                linkResultsMessage = 'Search for a file to link';
                setLinkHeadingOptions();
                renderLinkResults();
                return;
            }
            const requestId = ++linkSearchRequestId;
            try {
                const results = await options.searchLinks(query);
                if (requestId !== linkSearchRequestId || query !== linkSearchInput.value.trim()) {
                    return;
                }
                linkSearchResults = results;
                selectedLinkItem = results[0] ?? null;
                linkResultsMessage = results.length === 0 ? 'No matching files found' : 'Search for a file to link';
                renderLinkResults();
                if (selectedLinkItem) {
                    void loadHeadingsForItem(selectedLinkItem);
                } else {
                    setLinkHeadingOptions();
                }
            } catch {
                if (requestId !== linkSearchRequestId) {
                    return;
                }
                linkSearchResults = [];
                selectedLinkItem = null;
                linkResultsMessage = 'Search failed. Try again.';
                setLinkHeadingOptions();
                renderLinkResults();
            }
        };

        const closeLinkModal = (): void => {
            linkModal?.setAttribute('hidden', '');
            if (linkInput) { linkInput.value = ''; }
            if (linkLabelInput) { linkLabelInput.value = ''; }
            if (linkAliasInput) { linkAliasInput.value = ''; }
            if (linkSearchInput) { linkSearchInput.value = ''; }
            setLinkHeadingOptions();
            linkSearchResults = [];
            selectedLinkItem = null;
            linkResultsMessage = 'Search for a file to link';
            renderLinkResults();
        };

        const openLinkModalForSelection = (): void => {
            if (!linkModal) {
                return;
            }
            const selectedText = tiptap.state.doc.textBetween(tiptap.state.selection.from, tiptap.state.selection.to, ' ').trim();
            linkModal.removeAttribute('hidden');
            updateLinkMode('url');
            if (linkLabelInput) {
                linkLabelInput.value = selectedText;
            }
            if (linkInput) {
                linkInput.value = '';
                linkInput.focus();
            }
            linkSearchResults = [];
            selectedLinkItem = null;
            linkResultsMessage = 'Search for a file to link';
            setLinkHeadingOptions();
            renderLinkResults();
        };

        const handleLinkApply = (): void => {
            markUserEdit();
            if (linkMode === 'url') {
                const href = linkInput?.value?.trim();
                if (!href) {
                    closeLinkModal();
                    return;
                }
                const label = linkLabelInput?.value?.trim() || href;
                const { from, to, empty } = tiptap.state.selection;
                if (empty) {
                    tiptap.chain().focus().insertContent({
                        type: 'text',
                        text: label,
                        marks: [{ type: 'link', attrs: { href } }],
                    }).run();
                } else {
                    tiptap.chain()
                        .focus()
                        .deleteRange({ from, to })
                        .insertContent({
                            type: 'text',
                            text: label,
                            marks: [{ type: 'link', attrs: { href } }],
                        })
                        .run();
                }
            } else if (selectedLinkItem) {
                const selectedHeadingId = linkHeadingSelect?.value?.trim();
                const selectedHeadingText = linkHeadingSelect?.selectedOptions[0]?.dataset.headingText?.trim();
                const alias = linkAliasInput?.value?.trim();
                const pathPart = selectedLinkItem.path === options.currentFilePath ? '' : selectedLinkItem.wikiPath;
                const wikiLink = `[[${pathPart}${selectedHeadingId ? `#${selectedHeadingId}` : ''}${alias ? `|${alias}` : ''}]]`;
                const href = `${selectedLinkItem.relativePath}${selectedHeadingId ? `#${selectedHeadingId}` : ''}`;
                const label = alias || selectedHeadingText || selectedLinkItem.title;
                const { from, to, empty } = tiptap.state.selection;
                const insertChain = tiptap.chain().focus();
                if (!empty) {
                    insertChain.deleteRange({ from, to });
                }
                insertChain.insertContent({
                    type: 'text',
                    text: label,
                    marks: [{
                        type: 'link',
                        attrs: {
                            href,
                            title: `mcp-wiki:${encodeURIComponent(wikiLink)}`,
                        },
                    }],
                }).run();
            }
            closeLinkModal();
        };

        const handleFormatClick = (event: Event): void => {
            const target = event.currentTarget as HTMLButtonElement;
            const format = target.dataset.format;
            if (!format) {
                return;
            }
            markUserEdit();
            switch (format) {
                case 'bold':
                    tiptap.chain().focus().toggleBold().run();
                    break;
                case 'italic':
                    tiptap.chain().focus().toggleItalic().run();
                    break;
                case 'strike':
                    tiptap.chain().focus().toggleStrike().run();
                    break;
                case 'quote':
                    tiptap.chain().focus().toggleBlockquote().run();
                    break;
                case 'list':
                    tiptap.chain().focus().toggleBulletList().run();
                    break;
                case 'code':
                    tiptap.chain().focus().toggleCode().run();
                    break;
                case 'link':
                    openLinkModalForSelection();
                    break;
            }
        };

        const handleBlockStyleChange = (): void => {
            const value = blockStyleSelect?.value;
            if (!value) {
                return;
            }
            if (value === 'p') {
                markUserEdit();
                tiptap.chain().focus().setParagraph().run();
                return;
            }
            const match = /^h([1-6])$/.exec(value);
            if (match) {
                markUserEdit();
                const level = Number.parseInt(match[1], 10) as 1 | 2 | 3 | 4 | 5 | 6;
                tiptap.chain().focus().toggleHeading({ level }).run();
            }
        };

        const linkPopover = document.createElement('div');
        linkPopover.className = 'markdown-link-popover';
        linkPopover.hidden = true;
        editorDom.parentElement?.appendChild(linkPopover);
        let popoverHideTimer: ReturnType<typeof setTimeout> | null = null;

        const showLinkPopover = (anchor: HTMLAnchorElement): void => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
            const href = anchor.getAttribute('href') ?? '';
            linkPopover.innerHTML = `<button class="markdown-link-popover-btn" id="link-popover-edit" type="button" title="Edit link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="markdown-link-popover-btn" id="link-popover-open" type="button" title="Open link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`;
            linkPopover.hidden = false;

            linkPopover.querySelector('#link-popover-open')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                linkPopover.hidden = true;
                anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }, { once: true });

            linkPopover.querySelector('#link-popover-edit')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                linkPopover.hidden = true;
                if (!linkModal) {
                    return;
                }
                const pos = tiptap.view.posAtDOM(anchor, 0);
                if (pos >= 0) {
                    const endPos = pos + (anchor.textContent?.length ?? 0);
                    tiptap.chain().focus().setTextSelection({ from: pos, to: endPos }).run();
                }
                const label = anchor.textContent?.trim() ?? '';
                linkModal.removeAttribute('hidden');
                updateLinkMode('url');
                if (linkInput) { linkInput.value = href; }
                if (linkLabelInput) { linkLabelInput.value = label; }
            }, { once: true });

            const rect = anchor.getBoundingClientRect();
            const parent = editorDom.parentElement;
            if (!parent) {
                return;
            }
            const parentRect = parent.getBoundingClientRect();
            linkPopover.style.left = `${Math.max(4, rect.left - parentRect.left)}px`;
            linkPopover.style.top = `${rect.bottom - parentRect.top + 4}px`;
        };

        const hideLinkPopover = (): void => {
            popoverHideTimer = setTimeout(() => {
                linkPopover.hidden = true;
            }, 200);
        };

        const handleMouseOver = (e: MouseEvent): void => {
            const target = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
            if (target && editorDom.contains(target)) {
                showLinkPopover(target);
            }
        };
        const handleMouseOut = (e: MouseEvent): void => {
            const target = (e.target as HTMLElement)?.closest?.('a[href]');
            if (target) {
                hideLinkPopover();
            }
        };
        const handlePopoverEnter = (): void => {
            if (popoverHideTimer) {
                clearTimeout(popoverHideTimer);
                popoverHideTimer = null;
            }
        };
        const handlePopoverLeave = (): void => {
            hideLinkPopover();
        };
        const handleLinkModeFileClick = (): void => updateLinkMode('file');
        const handleLinkModeUrlClick = (): void => {
            updateLinkMode('url');
            linkInput?.focus();
        };
        const handleSearchInput = (): void => { void runLinkSearch(); };
        const handleModalBackdropClick = (e: MouseEvent): void => {
            if (e.target === linkModal) {
                closeLinkModal();
            }
        };

        editorDom.addEventListener('beforeinput', markUserEdit);
        editorDom.addEventListener('paste', markUserEdit);
        editorDom.addEventListener('cut', markUserEdit);
        editorDom.addEventListener('drop', markUserEdit);
        editorDom.addEventListener('mouseover', handleMouseOver);
        editorDom.addEventListener('mouseout', handleMouseOut);
        linkPopover.addEventListener('mouseenter', handlePopoverEnter);
        linkPopover.addEventListener('mouseleave', handlePopoverLeave);
        formatButtons.forEach((button) => button.addEventListener('click', handleFormatClick));
        blockStyleSelect?.addEventListener('change', handleBlockStyleChange);
        linkModeFile?.addEventListener('click', handleLinkModeFileClick);
        linkModeUrl?.addEventListener('click', handleLinkModeUrlClick);
        linkSearchInput?.addEventListener('input', handleSearchInput);
        linkApply?.addEventListener('click', handleLinkApply);
        linkCancel?.addEventListener('click', closeLinkModal);
        linkModal?.addEventListener('click', handleModalBackdropClick);

        if (typeof options.initialScrollTop === 'number') {
            editorDom.scrollTop = options.initialScrollTop;
        }
        renderLinkResults();

        return {
            destroy: () => {
                editorDom.removeEventListener('beforeinput', markUserEdit);
                editorDom.removeEventListener('paste', markUserEdit);
                editorDom.removeEventListener('cut', markUserEdit);
                editorDom.removeEventListener('drop', markUserEdit);
                editorDom.removeEventListener('mouseover', handleMouseOver);
                editorDom.removeEventListener('mouseout', handleMouseOut);
                linkPopover.removeEventListener('mouseenter', handlePopoverEnter);
                linkPopover.removeEventListener('mouseleave', handlePopoverLeave);
                formatButtons.forEach((button) => button.removeEventListener('click', handleFormatClick));
                blockStyleSelect?.removeEventListener('change', handleBlockStyleChange);
                linkModeFile?.removeEventListener('click', handleLinkModeFileClick);
                linkModeUrl?.removeEventListener('click', handleLinkModeUrlClick);
                linkSearchInput?.removeEventListener('input', handleSearchInput);
                linkApply?.removeEventListener('click', handleLinkApply);
                linkCancel?.removeEventListener('click', closeLinkModal);
                linkModal?.removeEventListener('click', handleModalBackdropClick);
                linkPopover.remove();
                if (popoverHideTimer) { clearTimeout(popoverHideTimer); }
                tiptap.destroy();
                options.target.replaceChildren();
            },
            focus: () => {
                tiptap.commands.focus();
            },
            getValue: () => getTiptapMarkdown(),
            setValue: (value: string) => {
                tiptap.commands.setContent(rewriteWikiLinks(value), { emitUpdate: false });
                previousSerializedValue = getTiptapMarkdown();
                syncHeadingIds(editorDom);
            },
            revealLine: (_lineNumber: number, headingId?: string) => {
                if (headingId) {
                    const heading = editorDom.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`);
                    if (heading) {
                        heading.scrollIntoView({ block: 'start', inline: 'nearest' });
                        editorDom.scrollTop = Math.max(editorDom.scrollTop - 24, 0);
                        heading.setAttribute('tabindex', '-1');
                        heading.focus({ preventScroll: true });
                        return;
                    }
                }
                tiptap.commands.focus();
            },
            setScrollTop: (scrollTop: number) => {
                editorDom.scrollTop = Math.max(0, scrollTop);
            },
        };
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'markdown-editor-textarea markdown-editor-textarea--raw';
    textarea.spellcheck = false;
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.placeholder = 'Edit raw markdown...';
    textarea.value = options.value;
    let previousTextareaValue = textarea.value;
    options.target.replaceChildren(textarea);

    const autosize = (): void => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.max(textarea.scrollHeight, 640)}px`;
    };

    const emitRawChange = (): void => {
        const value = textarea.value;
        const editRanges = computeSerializedEditRanges(previousTextareaValue, value);
        previousTextareaValue = value;
        options.onChange(value, editRanges);
    };

    const handleInput = (): void => {
        autosize();
        emitRawChange();
    };

    const handleFocusOut = (event: FocusEvent): void => {
        if (shouldIgnoreBlur(shell, event)) {
            return;
        }
        options.onBlur?.();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Tab') {
            return;
        }

        event.preventDefault();
        applyRawTab(textarea);
        autosize();
        emitRawChange();
    };

    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('keydown', handleKeyDown);
    textarea.addEventListener('focusout', handleFocusOut);
    autosize();
    if (typeof options.initialScrollTop === 'number') {
        textarea.scrollTop = options.initialScrollTop;
    }

    return {
        destroy: () => {
            textarea.removeEventListener('input', handleInput);
            textarea.removeEventListener('keydown', handleKeyDown);
            textarea.removeEventListener('focusout', handleFocusOut);
            options.target.replaceChildren();
        },
        focus: () => {
            textarea.focus();
        },
        getValue: () => textarea.value,
        setValue: (value: string) => {
            textarea.value = value;
            previousTextareaValue = value;
            autosize();
        },
        revealLine: (lineNumber: number) => {
            const targetLine = Math.max(1, Math.floor(lineNumber));
            const lines = textarea.value.split('\n');
            let index = 0;
            for (let currentLine = 1; currentLine < targetLine && currentLine <= lines.length; currentLine += 1) {
                index += lines[currentLine - 1].length + 1;
            }

            textarea.focus();
            textarea.setSelectionRange(index, index);

            const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight || '20') || 20;
            textarea.scrollTop = Math.max(0, (targetLine - 1) * lineHeight - lineHeight * 2);
        },
        setScrollTop: (scrollTop: number) => {
            textarea.scrollTop = Math.max(0, scrollTop);
        },
    };
}
