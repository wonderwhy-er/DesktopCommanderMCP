import assert from 'node:assert/strict';

export const DEVICE_ID = 'device';
export const doorbell = callId => ({ call_id: callId, user_id: 'owner', device_id: DEVICE_ID });

/**
 * An in-memory mcp_remote_calls table for the two queries the claim path sends:
 * the conditional claim (update) and the pending-call scan (select). It records
 * every claim request, and holdClaims() keeps claims waiting until released, so
 * two announcements of one call can overlap.
 */
export function makeCallsTable(rows) {
    const claimRequests = [];
    const scans = [];
    let claimsHeld = null;
    function holdClaims() {
        let release;
        claimsHeld = new Promise(resolve => { release = resolve; });
        return () => { claimsHeld = null; release(); };
    }
    function from(table) {
        assert.equal(table, 'mcp_remote_calls');
        const filters = {};
        let update = null;
        const query = {
            update(values) { update = values; return query; },
            select() { return query; },
            eq(key, value) { filters[key] = value; return query; },
            gt() { return query; },
            order() { return query; },
            limit() { return query; },
            maybeSingle() { return query; },
            then(resolve, reject) {
                const turn = update && claimsHeld ? claimsHeld : Promise.resolve();
                return turn.then(() => {
                    if (!update) {
                        scans.push({ ...filters });
                        const pending = rows.filter(row =>
                            row.device_id === filters.device_id && row.status === 'pending');
                        return { data: pending.map(({ id, device_id }) => ({ id, device_id })), error: null };
                    }
                    claimRequests.push(filters.id);
                    const row = rows.find(candidate =>
                        candidate.id === filters.id && candidate.status === filters.status);
                    if (!row) return { data: [], error: null };
                    Object.assign(row, update);
                    return { data: [{ ...row }], error: null };
                }).then(resolve, reject);
            },
        };
        return query;
    }
    return { from, claimRequests, scans, holdClaims };
}

/** A joined, ready RemoteChannel over the fake table; `delivered` lists the calls handed to device.ts. */
export function makeChannel(RemoteChannel, callIds) {
    const rows = callIds.map(id => ({ id, device_id: DEVICE_ID, status: 'pending', metadata: {} }));
    const table = makeCallsTable(rows);
    const delivered = [];
    const channel = new RemoteChannel();
    Object.assign(channel, {
        client: table,
        _user: { id: 'owner' },
        deviceId: DEVICE_ID,
        channel: { state: 'joined' },
        channelReady: true,
        localExecutorProbe: () => true,
        onToolCall: payload => delivered.push(payload.new.id),
    });
    return { channel, rows, delivered, table };
}
