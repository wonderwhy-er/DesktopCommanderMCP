import { withTimeout } from '../utils/withTimeout.js';

/** How long a request for the rollouts waits for the server's answer */
const REQUEST_TIMEOUT_MS = 3000;
/** How often a running device asks again, as often as feature flags are refreshed */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

type Rollouts = Record<string, boolean>;

/**
 * Which rollouts are on for this device's user. A rollout turns something on
 * for a share of users, and the Remote MCP server decides who is in. The
 * device asks at start, takes the map each call row carries, and asks again
 * every 30 minutes:
 *
 * - a start answer that fails (a refused token, a server error, a broken
 *   answer, no answer within 3 s) leaves every rollout off
 * - a call row without rollouts (an older server) keeps what the device has
 * - a 30-minute answer that fails keeps what the device has
 *
 * Each change logs a debug line, "Rollouts: …".
 */
class RolloutManager {
    private rollouts: Rollouts = {};
    private serverUrl = '';
    private getToken: () => Promise<string> = async () => '';
    private refreshInterval: NodeJS.Timeout | null = null;

    /**
     * GET {serverUrl}/device/rollouts with the session's access token, which
     * getToken() is asked for on every request. A failed answer leaves every
     * rollout off.
     */
    async load(serverUrl: string, getToken: () => Promise<string>): Promise<void> {
        this.serverUrl = serverUrl;
        this.getToken = getToken;
        this.replace((await this.request()) ?? {});
    }

    /** A call row's rollouts (metadata.rollouts); a row without them keeps what the device has */
    update(rollouts: unknown): void {
        if (isRolloutMap(rollouts)) this.replace(rollouts);
    }

    /** Asks again every 30 minutes, after load(); a failed answer keeps what the device has */
    startRefresh(): void {
        // The callback hands back the refresh's promise, which never rejects
        this.refreshInterval = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
        // A pending refresh must not keep a process that is otherwise done running
        this.refreshInterval.unref();
    }

    stopRefresh(): void {
        clearInterval(this.refreshInterval ?? undefined);
        this.refreshInterval = null;
    }

    /** Whether a rollout is on; `defaultValue` for one the server did not name */
    get(name: string, defaultValue = false): boolean {
        return this.rollouts[name] ?? defaultValue;
    }

    getAll(): Rollouts {
        return { ...this.rollouts };
    }

    private async refresh(): Promise<void> {
        const rollouts = await this.request();
        if (rollouts) this.replace(rollouts);
    }

    /** The server's answer, or undefined when it failed or took longer than 3 s */
    private request(): Promise<Rollouts | undefined> {
        return withTimeout<Rollouts | undefined>(this.fetchRollouts(), REQUEST_TIMEOUT_MS, 'Rollouts fetch', undefined);
    }

    private async fetchRollouts(): Promise<Rollouts> {
        const response = await fetch(`${this.serverUrl}/device/rollouts`, {
            headers: { Authorization: `Bearer ${await this.getToken()}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { rollouts } = await response.json();
        if (!isRolloutMap(rollouts)) throw new Error('No rollouts in the answer');
        return rollouts;
    }

    private replace(rollouts: Rollouts): void {
        if (JSON.stringify(rollouts) === JSON.stringify(this.rollouts)) return;
        this.rollouts = { ...rollouts };
        console.debug('Rollouts:', this.getAll());
    }
}

/** A name -> on/off object */
function isRolloutMap(value: unknown): value is Rollouts {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every((on) => typeof on === 'boolean');
}

export const rolloutManager = new RolloutManager();
