// Test-only transport routing: the device still validates the advertised HTTPS
// Supabase URL. Requests for the supabase2 project reach only the loopback stand-in.
function localTransportUrl(input) {
  const url = new URL(input);
  if (url.hostname !== 'xnalhwxchxhthlmzkhal.supabase.co') return url.href;
  const local = new URL(process.env.MCP_SERVER_URL);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || !local.port ||
      url.port || !['https:', 'wss:'].includes(url.protocol)) {
    throw new Error('The Supabase stand-in requires a local MCP test server and the pinned HTTPS/WSS endpoint');
  }
  url.protocol = url.protocol === 'https:' ? 'http:' : 'ws:';
  url.hostname = '127.0.0.1';
  url.port = local.port;
  return url.href;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => originalFetch(
  input instanceof Request ? new Request(localTransportUrl(input.url), input) : localTransportUrl(input),
  init,
);

const OriginalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends OriginalWebSocket {
  constructor(url, ...args) {
    super(localTransportUrl(url), ...args);
  }
};
