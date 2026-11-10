import os from "node:os";
import path from "node:path";

/** This is the hosted MCP API, not a value learned from /api/mcp-info. */
export const DEFAULT_REMOTE_SERVER_URL = "https://mcp.desktopcommander.app";
/** The production project's origin, independently verified against the hosted service. */
export const PRODUCTION_SUPABASE_ORIGIN = "https://olvbkozcufcbptfogatw.supabase.co";

export interface RemoteAuthContext {
    serverOrigin: string;
    supabaseUrl: string;
}

// This checks the hostname, not its resolved address. HTTP is only for the
// explicit local development hosts below; all remote endpoints require TLS.
export function isBackendLocal(url: URL): boolean {
    return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]", "mcp.localhost"].includes(url.hostname)
    );
}

function parseTrustedEndpoint(value: unknown, label: string): URL {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Invalid ${label}: expected a URL`);
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid ${label}: expected a URL`);
    }
    if (
        (url.protocol !== "https:" && !isBackendLocal(url)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error(`Unsafe ${label}: HTTPS or local HTTP required, without credentials, query, or fragment`);
    }
    return url;
}

/** Validate before requesting configuration or sending any device credentials. */
export function validateRemoteServerUrl(value: string): URL {
    const url = parseTrustedEndpoint(value, "MCP_SERVER_URL");
    if (url.pathname !== "/") {
        throw new Error("Unsafe MCP_SERVER_URL: paths are not supported");
    }
    return url;
}

/**
 * Validate the Supabase endpoint BEFORE setSession() can send persisted tokens.
 * For the hosted service, an arbitrary HTTPS Supabase project is not trusted.
 * Explicitly configured self-hosted/dev MCP servers retain their own HTTPS or
 * local HTTP Supabase endpoints; saved sessions are separately bound to them.
 */
export function validateRemoteAuthContext(serverUrl: string, supabaseUrl: unknown): RemoteAuthContext {
    const server = validateRemoteServerUrl(serverUrl);
    const auth = parseTrustedEndpoint(supabaseUrl, "Supabase URL");
    if (server.origin === DEFAULT_REMOTE_SERVER_URL &&
        (auth.origin !== PRODUCTION_SUPABASE_ORIGIN || auth.pathname !== "/")) {
        throw new Error("Unexpected Supabase backend for Desktop Commander production");
    }
    return {
        serverOrigin: server.origin,
        // Normalize a trailing slash, but preserve paths used by self-hosted gateways.
        supabaseUrl: auth.href.replace(/\/+$/, ""),
    };
}

/** Legacy unbound sessions may be restored ONLY against the pinned hosted backend. */
export function savedSessionMatchesContext(saved: unknown, expected: RemoteAuthContext): boolean {
    if (saved === undefined) {
        return expected.serverOrigin === DEFAULT_REMOTE_SERVER_URL &&
            expected.supabaseUrl === PRODUCTION_SUPABASE_ORIGIN;
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return false;
    const previous = saved as Partial<RemoteAuthContext>;
    return previous.serverOrigin === expected.serverOrigin &&
        previous.supabaseUrl === expected.supabaseUrl;
}

export function getRemoteDeviceConfigDirectory(home = os.homedir()): string {
    const suffix = "";
    // TODO: uncomment when staging/dev profiles are fully isolated
    // if (process.env.DC_ENV === "staging") {
    //     suffix = "-staging";
    // } else if (process.env.DC_ENV === "development") {
    //     suffix = "-dev";
    // }
    return path.join(home, `.desktop-commander-device${suffix}`);
}

export function getRemoteDeviceConfigPath(home = os.homedir()): string {
    return path.join(getRemoteDeviceConfigDirectory(home), "device.json");
}
