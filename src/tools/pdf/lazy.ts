/**
 * On-demand access to the PDF modules, keeping both out of the startup graph.
 *
 * ./index.js carries unpdf and pdf-lib and, through markdown.js, md-to-pdf and
 * the puppeteer it brings. ./chrome.js carries none of them: the server warms
 * Chrome up on every launch, so that path has to stay cheap.
 */

export const pdfTools = () => import('./index.js');

export const chromeTools = () => import('./chrome.js');
