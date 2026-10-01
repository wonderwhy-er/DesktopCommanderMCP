/**
 * The packages only Excel, DOCX and PDF files need, loaded in the background
 * right after initialize, one at a time (#715, review on #777).
 *
 * Loading them before answering initialize took 25-90 s on one reporter's
 * machine and timed the client out, and loading one inside the tool call that
 * first needs it can take longer than the few seconds a client gives a call.
 * So initialize loads none of them. Right after it, startBackgroundLoad()
 * loads them one by one, a turn of the event loop between them, so each pause
 * of the main thread is one package. Until a file type's packages are loaded,
 * the tool calls that need them answer at once (notReadyMessage(), checked in
 * server.ts). A load that fails isn't kept: the next check starts it again.
 *
 * Each package is loaded with the loader its own module uses on demand, so
 * code called without the server (tests, other callers) loads it as before.
 */
import path from 'path';
import { loadExcelJS } from './files/excel.js';
import { loadPizZip } from './files/docx.js';
import { loadPdf2md } from '../tools/pdf/lib/pdf2md.js';
import { loadUnpdf } from '../tools/pdf/extract-images.js';
import { loadMdToPdf } from '../tools/pdf/markdown.js';
import { loadPdfLib } from '../tools/pdf/manipulations.js';
import { logger } from './logger.js';

/** Each package and its module's loader, in the order the background load takes them (smaller first) */
const PACKAGES = {
    pizzip: loadPizZip,
    'pdf-lib': loadPdfLib,
    '@opendocsg/pdf2md': loadPdf2md,
    unpdf: loadUnpdf,
    exceljs: loadExcelJS,
    'md-to-pdf': loadMdToPdf,
} satisfies Record<string, () => unknown>;
type HeavyPackage = keyof typeof PACKAGES;

/** What a file type needs, and its name in the answers */
const SUPPORT = {
    excel: { name: 'Excel support', packages: ['exceljs'] },
    docx: { name: 'DOCX support', packages: ['pizzip'] },
    pdfRead: { name: 'PDF reading support', packages: ['@opendocsg/pdf2md', 'unpdf'] },
    pdfWrite: { name: 'PDF writing support', packages: ['md-to-pdf'] },
    pdfEdit: { name: 'PDF editing support', packages: ['pdf-lib'] },
} as const satisfies Record<string, { name: string; packages: readonly HeavyPackage[] }>;
export type HeavySupport = keyof typeof SUPPORT;

type LoadState = { status: 'loading'; done: Promise<void> } | { status: 'ready' } | { status: 'failed'; error: string };
const states = new Map<HeavyPackage, LoadState>();

/**
 * Loads `pkg` on a later turn of the event loop, never inside the caller's
 * (a tool call that starts it answers first). Resolves once loaded or failed.
 */
function load(pkg: HeavyPackage): Promise<void> {
    const state = states.get(pkg);
    if (state?.status === 'ready') return Promise.resolve();
    if (state?.status === 'loading') return state.done;
    const done = new Promise<void>((resolve) => setImmediate(resolve))
        .then(async () => { await PACKAGES[pkg](); })
        .then(
            () => { states.set(pkg, { status: 'ready' }); },
            (error) => {
                const message = error instanceof Error ? error.message : String(error);
                states.set(pkg, { status: 'failed', error: message });
                logger.error(`Loading ${pkg} failed: ${message}`);
            });
    states.set(pkg, { status: 'loading', done });
    return done;
}

/** Loads every package, one at a time; one already loaded or loading isn't loaded again */
export async function startBackgroundLoad(): Promise<void> {
    for (const pkg of Object.keys(PACKAGES) as HeavyPackage[]) {
        await load(pkg);
    }
}

/** Whether everything `support` needs is loaded */
export function isReady(support: HeavySupport): boolean {
    return SUPPORT[support].packages.every((pkg) => states.get(pkg)?.status === 'ready');
}

/** What a tool call does to the file, as its error says */
export type FileAction = 'read' | 'write' | 'edit';

/**
 * The error a tool call that needs `support` to `action` `filePath` answers
 * with while it isn't loaded, or undefined once it is. A package not started
 * yet (before initialize) or that failed is started here, after the call has
 * answered.
 */
export function notReadyMessage(support: HeavySupport, filePath: string, action: FileAction): string | undefined {
    const { name, packages } = SUPPORT[support];
    const file = path.basename(filePath);
    for (const pkg of packages) {
        const state = states.get(pkg);
        if (state?.status === 'ready') continue;
        if (state?.status === 'failed') {
            void load(pkg);
            return `Can't ${action} ${file}: Desktop Commander couldn't load its ${name} (${state.error}). It's loading it again; try again in a few seconds.`;
        }
        if (!state) void load(pkg);
        return `Can't ${action} ${file} yet: Desktop Commander is still loading its ${name} (it starts right after launch). Try again in a few seconds.`;
    }
    return undefined;
}
