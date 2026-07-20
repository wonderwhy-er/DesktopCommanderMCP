import assert from 'assert';
import { assertUrlIsFetchable, readFileFromUrl } from '../dist/tools/filesystem.js';
import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';

/**
 * Regression tests for #587 / #560: read_file with isUrl fetched arbitrary URLs
 * with no SSRF protection, so a URL like http://169.254.169.254/… could read
 * cloud instance metadata or reach internal services.
 *
 * assertUrlIsFetchable() now rejects non-http(s) schemes and any host that is
 * (or resolves to) a non-public address. These cases short-circuit before any
 * network access, so the test is hermetic — no outbound requests are made.
 */

let passed = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

// A minimal single-page PDF, inlined so the PDF check needs no fixture or network.
const MINIMAL_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoK' +
  'PDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUg' +
  'L1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8' +
  'IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQg' +
  'L1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGgg' +
  'MzMgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiAyMCAxMDAgVGQgKEhpKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhy' +
  'ZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4g' +
  'CjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWls' +
  'ZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMzk0CiUlRU9GCg==';

const BLOCKED_URLS = [
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/', // AWS metadata
  'http://[fd00::1]/',                                                  // IPv6 unique-local
  'http://127.0.0.1:8080/admin',                                        // loopback
  'http://localhost/internal',                                         // resolves to loopback
  'http://10.0.0.1/',                                                   // private
  'http://192.168.1.1/',                                               // private
  'http://172.16.5.4/',                                                // private
  'http://[::1]/',                                                     // IPv6 loopback
  'http://[fe90::1]/',                                                 // IPv6 link-local (fe80::/10, not just fe80::)
  'http://[::ffff:7f00:1]/',                                           // IPv4-mapped loopback in hex form (127.0.0.1)
  'file:///etc/passwd',                                                // non-http scheme
  'ftp://example.com/secret',                                          // non-http scheme
];

async function run() {
  for (const url of BLOCKED_URLS) {
    await assert.rejects(
      () => assertUrlIsFetchable(url),
      (err) => err instanceof Error && /not allowed|non-public|Invalid URL|resolve/i.test(err.message),
      `assertUrlIsFetchable should reject ${url}`
    );
  }
  ok(`assertUrlIsFetchable rejects all ${BLOCKED_URLS.length} SSRF / non-http URLs`);

  // readFile(isUrl) routes through the same guard, so the metadata PoC is
  // blocked before any request leaves the process.
  await assert.rejects(
    () => readFileFromUrl('http://169.254.169.254/latest/meta-data/'),
    /non-public/i,
    'readFileFromUrl should refuse the cloud metadata endpoint'
  );
  ok('readFileFromUrl refuses the cloud metadata endpoint');

  // A public address with a valid scheme passes validation. An IP literal is
  // used so the check needs no outbound DNS and stays hermetic; no request is
  // made — we only assert the guard itself does not reject it.
  await assert.doesNotReject(
    () => assertUrlIsFetchable('https://8.8.8.8/file.txt'),
    'a public https URL must pass the guard'
  );
  ok('a public https address passes the guard');

  // readFileFromUrl hands the PDF parser the bytes it already fetched through the
  // guard; passing the URL made the parser download it a second time, re-resolving
  // DNS outside these checks. That requires the parser to accept bytes — it used
  // to treat every source as a path or URL.
  const parsed = await parsePdfToMarkdown(Buffer.from(MINIMAL_PDF_BASE64, 'base64'));
  assert.strictEqual(parsed.metadata.totalPages, 1, 'byte input should parse as a PDF');
  ok('parsePdfToMarkdown accepts already-fetched bytes');
}

run()
  .then(() => { console.log(`\nPASS (${passed}/4)`); process.exit(0); })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
