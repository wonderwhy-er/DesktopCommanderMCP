import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { buildDocumentLayout } from '../dist/ui/file-preview/src/document-layout.js';

function buildLayoutWith(overrides = {}) {
  return buildDocumentLayout({
    payload: {
      fileName: 'notes.md',
      filePath: '/tmp/notes.md',
      fileType: 'markdown',
      content: '# Hello\n',
      ...overrides.payload,
    },
    body: {
      html: '<div class="panel-content"><p>Hello</p></div>',
      ...overrides.body,
    },
    capabilities: {
      supportsPreview: true,
      canCopy: false,
      canOpenInFolder: true,
    },
    fileExtension: overrides.fileExtension ?? 'md',
    htmlMode: 'rendered',
    currentDisplayMode: 'inline',
    isExpanded: true,
    hideSummaryRow: false,
    canGoFullscreen: true,
    isMarkdownUndoAvailable: false,
    markdownEditorAppIcon: '',
    hasDirectoryBackButton: false,
  });
}

test('escapes HTML payloads in file-preview notice banner without creating child elements', () => {
  const maliciousNotice =
    'Heading not found: <img src=x onerror="alert(1)"> & <script>alert(2)</script> \'quoted\'';
  const layout = buildLayoutWith({ body: { notice: maliciousNotice } });

  assert.ok(
    layout.html.includes(
      '<div class="notice">Heading not found: &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;script&gt;alert(2)&lt;/script&gt; &#39;quoted&#39;</div>',
    ),
    'notice HTML should escape special HTML characters',
  );

  const dom = new JSDOM(layout.html);
  const noticeEl = dom.window.document.querySelector('.notice');
  assert.ok(noticeEl, 'notice element should be rendered');
  assert.equal(noticeEl.querySelectorAll('*').length, 0, 'notice must not contain injected HTML elements');
  assert.equal(noticeEl.textContent, maliciousNotice, 'notice textContent should match original string');
});

test('preserves plain-text notice banner', () => {
  const plainNotice = 'Invalid JSON. Showing raw source.';
  const layout = buildLayoutWith({ body: { notice: plainNotice } });

  assert.ok(layout.html.includes(`<div class="notice">${plainNotice}</div>`));

  const dom = new JSDOM(layout.html);
  const noticeEl = dom.window.document.querySelector('.notice');
  assert.ok(noticeEl);
  assert.equal(noticeEl.textContent, plainNotice);
});

test('omits notice banner when notice is absent', () => {
  const layout = buildLayoutWith({ body: { notice: undefined } });
  const dom = new JSDOM(layout.html);
  assert.equal(dom.window.document.querySelector('.notice'), null);
});

test('escapes HTML characters in footer file extension label', () => {
  const layout = buildLayoutWith({
    payload: {
      fileName: 'payload.<svg onload=alert(1)>',
      filePath: '/tmp/payload.<svg onload=alert(1)>',
      fileType: 'text',
    },
    fileExtension: '<svg onload=alert(1)>',
  });

  const dom = new JSDOM(layout.html);
  const footerSpan = dom.window.document.querySelector('.panel-footer span');
  assert.ok(footerSpan, 'footer label span should be rendered');
  assert.equal(footerSpan.querySelectorAll('*').length, 0, 'footer must not contain injected HTML elements');
  assert.ok(footerSpan.textContent.includes('<SVG ONLOAD=ALERT(1)>'));
});
