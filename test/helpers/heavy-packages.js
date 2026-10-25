/**
 * Tool calls for Excel, DOCX and PDF files through the real server, the way a
 * client gets past the server's background load: right after initialize, while
 * the support for a file type is still loading, the server answers "Can't read
 * report.xlsx yet: Desktop Commander is still loading its Excel support …".
 * callToolOnceLoaded() tries again until it doesn't (read_multiple_files says
 * so per file).
 */

export const STILL_LOADING = /Desktop Commander is still loading its [A-Za-z ]+ support/;

const textOf = (result) => (result.content ?? []).map((item) => item.text ?? '').join('\n');

/** client.callTool(params), again every 100 ms while the answer says the support is still loading, up to timeoutMs */
export async function callToolOnceLoaded(client, params, { timeoutMs = 60_000, requestOptions } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.callTool(params, undefined, requestOptions);
    if (!STILL_LOADING.test(textOf(result)) || Date.now() > deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
