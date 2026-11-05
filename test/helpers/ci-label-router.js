/** Default-branch fallback only; branches with a workflow retain their native path. */
import { isMaintainer, platformsFor, reviewFor, matrixFor, osOf } from './ci-platforms.js';

export function legacyRoute({
  event,
  actor,
  permission,
  repo,
  live,
  nativeAtHead,
  nativeAtBase,
  probedHead,
  probedBase
}) {
  const skip = (reason) => ({ os: [], matrix: { os: [] }, review: false, reason });
  if (!['labeled', 'synchronize', 'reopened'].includes(event.action)) return skip('action');
  if (!isMaintainer(actor) || event.sender?.login?.toLowerCase() !== actor.toLowerCase()) return skip('actor');
  if (!['write', 'maintain', 'admin'].includes(permission)) return skip('permission');
  if (live?.state !== 'open' || live.number !== event.pull_request?.number || !isMaintainer(live.user?.login))
    return skip('PR');
  if (live.head?.repo?.full_name !== repo || live.base?.repo?.full_name !== repo) return skip('fork');
  if (!/^[a-f0-9]{40}$/.test(live.head?.sha) || !/^[a-f0-9]{40}$/.test(live.base?.sha)) return skip('SHA');
  if (live.head.sha !== event.pull_request.head?.sha || live.base.sha !== event.pull_request.base?.sha)
    return skip('stale');
  // Workflow absence applies only to the exact head and base that were probed.
  if (live.head.sha !== probedHead || live.base.sha !== probedBase) return skip('changed workflow snapshot');
  if (nativeAtHead !== false || nativeAtBase !== false) return skip('native workflow or unknown');
  if (event.action === 'labeled' && !(live.labels ?? []).some((label) => label.name === event.label?.name))
    return skip('removed label');
  const normalized = { ...event, pull_request: live };
  const platforms = platformsFor('pull_request', normalized);
  return {
    os: osOf(platforms),
    matrix: matrixFor(osOf(platforms), { tests: '' }),
    review: reviewFor('pull_request', normalized),
    sha: live.head.sha,
    pr: String(live.number),
    base: live.base.sha
  };
}
