/**
 * On-demand access to the PDF module tree.
 *
 * Same shape as the handler getters in src/utils/files/factory.ts: the caller
 * imports a named accessor at the top of its file, and the import() that
 * actually loads the module lives here, in one place, instead of being spelled
 * out at every call site.
 *
 * ./index.js is not in the startup graph because it is expensive: it pulls in
 * unpdf and pdf-lib and, through markdown.js, md-to-pdf and with it puppeteer.
 *
 * ./chrome.js is the cheap half. The server warms Chrome up on every launch, so
 * that path must not reach the renderer; @puppeteer/browsers is loaded inside it
 * only when a download is actually needed.
 */

/** PDF reading, writing and editing: parsePdfToMarkdown, parseMarkdownToPdf, editPdf. */
export const pdfTools = () => import('./index.js');

/** Chrome discovery and download for PDF generation: ensureChromeAvailable. */
export const chromeTools = () => import('./chrome.js');
