import assert from 'assert';
import { assertUrlIsFetchable, readFileFromUrl } from '../dist/tools/filesystem.js';

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

const BLOCKED_URLS = [
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/', // AWS metadata
  'http://[fd00::1]/',                                                  // IPv6 unique-local
  'http://127.0.0.1:8080/admin',                                        // loopback
  'http://localhost/internal',                                         // resolves to loopback
  'http://10.0.0.1/',                                                   // private
  'http://192.168.1.1/',                                               // private
  'http://172.16.5.4/',                                                // private
  'http://[::1]/',                                                     // IPv6 loopback
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
}

run()
  .then(() => { console.log(`\nPASS (${passed}/3)`); process.exit(0); })
  .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
