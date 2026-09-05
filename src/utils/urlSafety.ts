import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import ipaddr from 'ipaddr.js';
import fetch from 'cross-fetch';

// Follow at most this many redirects when reading a URL, re-validating each hop.
const MAX_URL_REDIRECTS = 5;

/**
 * Returns true if an IP address is not publicly routable — loopback, private,
 * link-local (including the 169.254.169.254 cloud metadata endpoint), unique
 * local, CGNAT, multicast, or otherwise reserved. Anything that isn't a valid
 * IP is treated as blocked so a malformed value can't slip through.
 *
 * Uses ipaddr.js for CIDR-correct classification across IPv4 and IPv6: only the
 * `unicast` range is publicly routable, everything else is refused. IPv4-mapped
 * IPv6 (e.g. `::ffff:127.0.0.1` and its hex form `::ffff:7f00:1`) is unwrapped
 * to its IPv4 address first so the underlying range is what gets checked.
 */
function isBlockedAddress(ip: string): boolean {
    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    try {
        addr = ipaddr.parse(ip.split('%')[0]); // drop any IPv6 zone id
    } catch {
        return true;
    }
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
        addr = (addr as ipaddr.IPv6).toIPv4Address();
    }
    return addr.range() !== 'unicast';
}

/** An address that passed the SSRF checks, in `dns.lookup` shape. */
export interface ValidatedAddress {
    address: string;
    family: number;
}

/**
 * Guards against SSRF before a URL is fetched. Allows only http(s), and rejects
 * hosts that are — or that resolve to — non-public addresses. Every resolved
 * address is checked, so a hostname pointing at an internal IP is blocked too.
 *
 * @param rawUrl The URL about to be fetched
 * @returns The addresses the host was validated as — connect to these rather
 *          than resolving the hostname again, or the second lookup can be
 *          rebound to an internal address after the check passed
 * @throws Error if the URL is not safe to fetch
 */
export async function assertUrlIsFetchable(rawUrl: string): Promise<ValidatedAddress[]> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`URL protocol not allowed: ${parsed.protocol} — only http and https can be read`);
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

    if (ipaddr.isValid(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw new Error(`Refusing to fetch a URL that targets a non-public address: ${hostname}`);
        }
        return [{ address: hostname, family: ipaddr.parse(hostname.split('%')[0]).kind() === 'ipv6' ? 6 : 4 }];
    }

    let resolved: Array<{ address: string; family: number }>;
    try {
        resolved = await dns.lookup(hostname, { all: true });
    } catch {
        throw new Error(`Could not resolve host: ${hostname}`);
    }
    if (resolved.length === 0) {
        throw new Error(`Could not resolve host: ${hostname}`);
    }
    for (const { address } of resolved) {
        if (isBlockedAddress(address)) {
            throw new Error(
                `Refusing to fetch a URL that resolves to a non-public address: ${hostname} -> ${address}`
            );
        }
    }
    return resolved.map(({ address, family }) => ({ address, family }));
}

/**
 * An http(s) agent that connects only to the given pre-validated addresses
 * instead of resolving the hostname again. The socket-level lookup re-resolving
 * the name is what makes DNS rebinding work: a host can pass the guard and then
 * serve an internal address to the connection's own lookup. TLS SNI and
 * certificate checks still run against the original hostname.
 */
function pinnedAgentFor(url: URL, addresses: ValidatedAddress[]): http.Agent {
    const lookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) {
            callback(null, addresses.map(({ address, family }) => ({ address, family })));
        } else {
            callback(null, addresses[0].address, addresses[0].family);
        }
    };
    return url.protocol === 'https:' ? new https.Agent({ lookup }) : new http.Agent({ lookup });
}

/**
 * Releases a response we are not going to return (a redirect hop), so its
 * unread body does not hold the connection open. Handles both body shapes:
 * a WHATWG stream (`cancel`) and node-fetch's Node stream (`destroy`).
 */
function discardResponseBody(response: Awaited<ReturnType<typeof fetch>>): void {
    const body = response.body as { cancel?: () => Promise<void>; destroy?: () => void } | null;
    if (body && typeof body.cancel === 'function') {
        body.cancel().catch(() => {});
    } else if (body && typeof body.destroy === 'function') {
        body.destroy();
    }
}

/**
 * Fetches a URL with the SSRF guard applied to the initial request and to every
 * redirect hop — a public URL must not be able to redirect us onto an internal
 * address. Each hop's socket connects to the addresses the guard validated
 * (never re-resolving the hostname), closing the DNS-rebinding window between
 * check and connect. All code that downloads a user-supplied URL must go
 * through this (or pass already-downloaded bytes onward) rather than calling
 * fetch directly.
 *
 * @param fetchImpl Overridable for hermetic tests; defaults to cross-fetch
 * @returns The final response and the URL it actually came from
 */
export async function fetchUrlValidated(
    url: string,
    signal?: AbortSignal,
    fetchImpl: typeof fetch = fetch
): Promise<{ response: Awaited<ReturnType<typeof fetch>>; finalUrl: string }> {
    let currentUrl = url;
    let response!: Awaited<ReturnType<typeof fetch>>;
    for (let hop = 0; ; hop++) {
        const addresses = await assertUrlIsFetchable(currentUrl);
        const parsed = new URL(currentUrl);
        response = await fetchImpl(currentUrl, {
            signal,
            redirect: 'manual',
            // cross-fetch is node-fetch on Node, which connects through this
            // agent; runtimes with WHATWG fetch ignore the extra field.
            agent: pinnedAgentFor(parsed, addresses)
        } as RequestInit);

        if (response.status < 300 || response.status >= 400) {
            break;
        }

        const location = response.headers.get('location');
        if (!location) {
            break; // redirect status without a target — treat as final
        }
        discardResponseBody(response); // this hop's body is never read
        if (hop >= MAX_URL_REDIRECTS) {
            throw new Error(`Too many redirects while fetching URL: ${url}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
    }

    return { response, finalUrl: currentUrl };
}
