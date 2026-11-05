/** Runs only from the trusted default-branch checkout, without executing PR code. */
import fs from 'node:fs';
import { legacyRoute } from './helpers/ci-label-router.js';
import { isMaintainer } from './helpers/ci-platforms.js';
import { githubApi } from './helpers/github-api.js';

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const repo = process.env.GITHUB_REPOSITORY;
if (repo !== 'wonderwhy-er/DesktopCommanderMCP' || process.env.GITHUB_EVENT_NAME !== 'pull_request_target')
  throw Error('Unexpected router repository or event');
const actor = process.env.GITHUB_ACTOR;
const trigger = process.env.GITHUB_TRIGGERING_ACTOR || actor;
if (!isMaintainer(actor) || !isMaintainer(trigger)) throw Error('Router actor is not a maintainer');
const api = githubApi({ api: process.env.GITHUB_API_URL, token: process.env.GH_TOKEN });
const get = (part) => api('GET', `/repos/${repo}${part}`);
const permission = async (login) => (await get(`/collaborators/${encodeURIComponent(login)}/permission`)).permission;
const access = await permission(actor);
if (trigger !== actor && !['write', 'maintain', 'admin'].includes(await permission(trigger)))
  throw Error('Rerun actor lacks write access');
const number = event.pull_request?.number;
if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid PR number');
const live = await get(`/pulls/${number}`);
const present = async (sha) => {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Invalid source SHA');
  try {
    await get(`/contents/.github/workflows/tests.yml?ref=${sha}`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
};
const [nativeAtHead, nativeAtBase] = await Promise.all([present(live.head?.sha), present(live.base?.sha)]);
const latest = await get(`/pulls/${number}`);
const routeOutputs = legacyRoute({
  event,
  actor,
  permission: access,
  repo,
  live: latest,
  nativeAtHead,
  nativeAtBase,
  probedHead: live.head.sha,
  probedBase: live.base.sha
});
for (const [name, value] of Object.entries(routeOutputs)) {
  const line = `${name}=${typeof value === 'object' ? JSON.stringify(value) : value}`;
  console.log(line);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, line + '\n');
}
