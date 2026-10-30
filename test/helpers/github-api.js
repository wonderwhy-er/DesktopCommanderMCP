/**
 * GitHub's REST API with a token, for CI's scripts (test/ci-comment.js,
 * test/ci-review.js): JSON in and out. Any other answer than 2xx throws, with
 * the status on the error (`error.status`).
 */
export function githubApi({ api = 'https://api.github.com', token }) {
  return async function github(method, url, body) {
    const response = await fetch(url.startsWith('http') ? url : `${api}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
}
