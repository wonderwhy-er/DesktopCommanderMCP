import os from "node:os";
import path from "node:path";

/** This is the hosted MCP API, not a value learned from /api/mcp-info. */
export const DEFAULT_REMOTE_SERVER_URL = "https://mcp.desktopcommander.app";
/** Trusted project endpoints; never learned from /api/mcp-info. */
export const SUPABASE1_ORIGIN = "https://olvbkozcufcbptfogatw.supabase.co";
export const SUPABASE2_ORIGIN = "https://xnalhwxchxhthlmzkhal.supabase.co";

export interface RemoteAuthContext {
    serverOrigin: string;
    supabaseUrl: string;
}

const LOCAL_BACKEND_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]", "mcp.localhost"];

// This checks the hostname, not its resolved address. HTTP is only for the
// explicit local development hosts below; all remote endpoints require TLS.
export function isBackendLocal(url: URL): boolean {
    return (
        url.protocol === "http:" &&
        LOCAL_BACKEND_HOSTNAMES.includes(url.hostname)
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
    // Match a complete DNS label so lookalikes such as evildesktopcommander.app
    // and desktopcommander.app.example.com cannot become credential recipients.
    const isDesktopCommanderHost = url.hostname === "desktopcommander.app" ||
        url.hostname.endsWith(".desktopcommander.app");
    if (!isDesktopCommanderHost && !LOCAL_BACKEND_HOSTNAMES.includes(url.hostname)) {
        throw new Error("Unsafe MCP_SERVER_URL: use desktopcommander.app, one of its subdomains, or a supported local host");
    }
    if (url.pathname !== "/") {
        throw new Error("Unsafe MCP_SERVER_URL: paths are not supported");
    }
    return url;
}

/**
 * Validate the Supabase endpoint BEFORE setSession() can send persisted tokens.
 * Accept only the supabase1 and supabase2 project endpoints. Saved sessions are
 * separately bound to their exact MCP and Supabase endpoints before restoration.
 */
export function validateRemoteAuthContext(serverUrl: string, supabaseUrl: unknown): RemoteAuthContext {
    const server = validateRemoteServerUrl(serverUrl);
    const auth = parseTrustedEndpoint(supabaseUrl, "Supabase URL");
    // Compare the complete origin, including scheme and port; paths are never endpoints.
    if ((auth.origin !== SUPABASE1_ORIGIN && auth.origin !== SUPABASE2_ORIGIN) ||
        auth.pathname !== "/") {
        throw new Error("Unsafe Supabase URL: only the supabase1 and supabase2 project URLs are allowed, without paths");
    }
    return {
        serverOrigin: server.origin,
        supabaseUrl: auth.origin,
    };
}

/** Legacy unbound sessions may be restored ONLY against the original default MCP/supabase1 pair. */
export function savedSessionMatchesContext(saved: unknown, expected: RemoteAuthContext): boolean {
    if (saved === undefined) {
        return expected.serverOrigin === DEFAULT_REMOTE_SERVER_URL &&
            expected.supabaseUrl === SUPABASE1_ORIGIN;
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
