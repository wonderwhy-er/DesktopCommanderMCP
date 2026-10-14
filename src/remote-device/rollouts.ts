import { withTimeout } from '../utils/withTimeout.js';

/** How long a start waits for the server's answer before running with every rollout off */
const LOAD_TIMEOUT_MS = 3000;

/**
 * Which rollouts are on for this device's user. A rollout turns something on
 * for a share of users, and the Remote MCP server decides who is in: the
 * device asks it once per run, after sign-in, and keeps the answer.
 */
class RolloutManager {
    private rollouts: Record<string, boolean> = {};

    /**
     * GET {serverUrl}/device/rollouts with the session's access token. Any
     * failure (a refused token, a server error, a broken answer, no answer
     * within 3 s) leaves every rollout off for this run.
     */
    async load(serverUrl: string, accessToken: string): Promise<void> {
        this.rollouts = await withTimeout(this.fetchRollouts(serverUrl, accessToken), LOAD_TIMEOUT_MS, 'Rollouts fetch', {});
    }

    /** Whether a rollout is on; `defaultValue` for one the server did not name */
    get(name: string, defaultValue = false): boolean {
        return this.rollouts[name] ?? defaultValue;
    }

    getAll(): Record<string, boolean> {
        return { ...this.rollouts };
    }

    private async fetchRollouts(serverUrl: string, accessToken: string): Promise<Record<string, boolean>> {
        const response = await fetch(`${serverUrl}/device/rollouts`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { rollouts } = await response.json();
        if (!rollouts || typeof rollouts !== 'object') throw new Error('No rollouts in the answer');
        return rollouts;
    }
}

export const rolloutManager = new RolloutManager();
