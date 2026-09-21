import { randomUUID } from "node:crypto";

// In-memory Supabase boundary for local reliability tests, not an RLS/server emulator.
// Filters/claims run atomically after injected asynchronous I/O, reads return snapshots,
// and AbortSignals cancel the wait. Real PostgreSQL arbitration has a separate test lane.
export function memoryDatabase() {
    const calls = new Map();
    const devices = new Map();
    const failClaims = new Set();
    const writes = [];
    const operations = [];
    const deletions = [];
    // Tests inject delay/errors through before() while observing issued operations and writes.
    const db = { calls, devices, failClaims, writes, operations, deletions, client, before: async () => null };
    /** Give each simulated connector its own user scope over the shared row maps. */
    function client(userId) {
        return {
            // Model the result-cleanup RPC expected by server-side consumers of this fixture.
            async rpc(name, args) {
                if (name !== "delete_tool_call") { throw new Error(`Unexpected test RPC: ${name}`); }
                const row = calls.get(args.p_call_id);
                deletions.push(args.p_call_id);
                calls.delete(args.p_call_id);
                return { data: row ? Buffer.byteLength(JSON.stringify(row.result ?? null)) : null, error: null };
            },
            // Build one awaitable PostgREST-shaped query; predicates accumulate until execution.
            from(table) {
                const filters = [];
                let patch;
                let inserted;
                let signal;
                // Fluent methods only record selection/filter/write intent. single/maybeSingle
                // and await (then) trigger the same execution path with the expected row shape.
                const chain = {
                    select() { return chain; },
                    abortSignal(value) { signal = value; return chain; },
                    eq(key, value) { filters.push((row) => row[key] === value); return chain; },
                    in(key, values) { filters.push((row) => values.includes(row[key])); return chain; },
                    gt(key, value) { filters.push((row) => key === "timeout_at" ? Date.parse(row[key]) > Date.parse(value) : row[key] > value); return chain; },
                    update(value) { patch = value; return chain; },
                    insert(value) { inserted = { id: randomUUID(), ...value }; return chain; },
                    single() { return execute(true); },
                    maybeSingle() { return execute(true); },
                    // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are intentionally awaitable.
                    then(resolve, reject) { return execute(false).then(resolve, reject); },
                };
                /** Apply the injected I/O fault, then evaluate filters and mutate without an await. */
                async function execute(single) {
                    const kind = inserted ? "insert" : patch?.status === "executing" ? "claim" : patch ? "write" : "read";
                    const operation = { table, kind, patch, signal };
                    operations.push(operation);
                    let onAbort;
                    try {
                        // Race the fixture's stalled I/O with production's AbortSignal; aborting
                        // must return before applying the patch, even if the gate resolves later.
                        const fault = await Promise.race([
                            Promise.resolve().then(() => db.before(operation)),
                            new Promise((_, reject) => {
                                // Mirror fetch cancellation whether signalled now or after setup.
                                onAbort = () => reject(signal.reason || new Error("aborted"));
                                if (signal?.aborted) { onAbort(); }
                                else { signal?.addEventListener("abort", onAbort, { once: true }); }
                            }),
                        ]);
                        if (fault) { return { data: null, error: fault }; }
                        const rows = table === "mcp_remote_calls" ? calls : devices;
                        if (inserted) {
                            rows.set(inserted.id, structuredClone(inserted));
                            return { data: structuredClone(inserted), error: null };
                        }
                        // No async gap between matching and mutation: two claimers cannot both
                        // observe pending. User filtering is a test model, not proof of real RLS.
                        const matched = [...rows.values()].filter((row) => (!userId || row.user_id === userId) && filters.every((fn) => fn(row)));
                        if (kind === "claim" && matched.some((row) => failClaims.has(row.id))) {
                            return { data: null, error: { message: "injected claim failure" } };
                        }
                        if (patch) {
                            for (const row of matched) {
                                Object.assign(row, structuredClone(patch));
                                writes.push({ id: row.id, ...structuredClone(patch) });
                            }
                        }
                        // Snapshot semantics stop a later write from changing an earlier fetched row.
                        return { data: structuredClone(single ? matched[0] ?? null : matched), error: null };
                    } catch (error) {
                        return { data: null, error };
                    } finally {
                        // Repeated fault runs must not leave abort listeners on completed operations.
                        if (onAbort) { signal?.removeEventListener("abort", onAbort); }
                    }
                }
                return chain;
            },
        };
    }
    return db;
}
