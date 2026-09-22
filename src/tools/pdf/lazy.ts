/**
 * On-demand access to the PDF module tree.
 *
 * Same shape as the handler getters in src/utils/files/factory.ts: the caller
 * imports a named accessor at the top of its file, and the import() that
 * actually loads the module lives here, in one place, instead of being spelled
 * out at every call site.
 *
 * These modules are not in the startup graph because they are expensive:
 * ./index.js pulls in unpdf and pdf-lib and, through markdown.js, md-to-pdf;
 * ./markdown.js pulls in md-to-pdf, and with it puppeteer.
 */

/** PDF reading, writing and editing: parsePdfToMarkdown, parseMarkdownToPdf, editPdf. */
export const pdfTools = () => import('./index.js');

/** Chrome discovery and download for PDF generation: ensureChromeAvailable. */
export const chromeTools = () => import('./markdown.js');
