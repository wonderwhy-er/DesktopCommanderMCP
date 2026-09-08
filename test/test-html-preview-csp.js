import assert from 'assert';
import { renderHtmlPreview } from '../dist/ui/file-preview/src/components/html-renderer.js';

const rendered = renderHtmlPreview('<script>fetch("https://example.com")</script>', 'rendered');

assert.ok(rendered.html.includes('Content-Security-Policy'));
assert.ok(rendered.html.includes('connect-src &#39;none&#39;'));
assert.ok(rendered.html.includes('form-action &#39;none&#39;'));
assert.ok(rendered.html.includes('sandbox="allow-scripts allow-forms allow-popups"'));
assert.ok(rendered.html.includes('&lt;script&gt;fetch(&quot;https://example.com&quot;)&lt;/script&gt;'));

console.log('PASS: rendered HTML previews carry a restrictive CSP');
