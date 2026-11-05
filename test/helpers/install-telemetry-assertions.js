import assert from 'assert';

/** Checks the HTTP contract as well as the payload, including byte length rather than character count. */
export function assertTelemetryRequests(posts) {
  assert.ok(posts.length > 0, 'the script sent telemetry');
  for (const post of posts) {
    const headers = Object.fromEntries(Object.entries(post.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    assert.strictEqual(post.method, 'POST', 'telemetry uses POST');
    assert.strictEqual(headers['content-type'], 'application/json', 'telemetry sends JSON');
    assert.strictEqual(Number(headers['content-length']), Buffer.byteLength(post.body), 'the payload byte length');
  }
}
