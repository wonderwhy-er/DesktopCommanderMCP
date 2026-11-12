// Test-only transport routing: production still validates the advertised HTTPS
// Supabase URL. Only this fixture hostname reaches the loopback stand-in.
function localTransportUrl(input) {
  const url = new URL(input);
  if (url.hostname !== 'remote-stand-in.supabase.co') return url.href;
  if (!url.port || !['https:', 'wss:'].includes(url.protocol)) {
    throw new Error('The Supabase stand-in requires HTTPS/WSS and an explicit test port');
  }
  url.protocol = url.protocol === 'https:' ? 'http:' : 'ws:';
  url.hostname = '127.0.0.1';
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
