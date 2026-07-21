import dns from 'dns/promises';
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

/**
 * Guards against SSRF before a URL is fetched. Allows only http(s), and rejects
 * hosts that are — or that resolve to — non-public addresses. Every resolved
 * address is checked, so a hostname pointing at an internal IP is blocked too.
 *
 * @param rawUrl The URL about to be fetched
 * @throws Error if the URL is not safe to fetch
 */
export async function assertUrlIsFetchable(rawUrl: string): Promise<void> {
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
        return;
    }

    let resolved: Array<{ address: string }>;
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
}

/**
 * Fetches a URL with the SSRF guard applied to the initial request and to every
 * redirect hop — a public URL must not be able to redirect us onto an internal
 * address. All code that downloads a user-supplied URL must go through this
 * (or pass already-downloaded bytes onward) rather than calling fetch directly.
 *
 * @returns The final response and the URL it actually came from
 */
export async function fetchUrlValidated(
    url: string,
    signal?: AbortSignal
): Promise<{ response: Awaited<ReturnType<typeof fetch>>; finalUrl: string }> {
    await assertUrlIsFetchable(url);

    let currentUrl = url;
    let response!: Awaited<ReturnType<typeof fetch>>;
    for (let hop = 0; ; hop++) {
        response = await fetch(currentUrl, {
            signal,
            redirect: 'manual'
        });

        if (response.status < 300 || response.status >= 400) {
            break;
        }

        const location = response.headers.get('location');
        if (!location) {
            break; // redirect status without a target — treat as final
        }
        if (hop >= MAX_URL_REDIRECTS) {
            throw new Error(`Too many redirects while fetching URL: ${url}`);
        }
        const nextUrl = new URL(location, currentUrl).toString();
        await assertUrlIsFetchable(nextUrl);
        currentUrl = nextUrl;
    }

    return { response, finalUrl: currentUrl };
}
