import http from 'http';

/**
 * A local stand-in for the services a remote device talks to, so a real
 * device process (dist/remote-device/device.js) can be started, restarted and
 * watched without the network:
 *
 * - mcp.desktopcommander.app: /api/mcp-info points the device at this server
 *   as its Supabase; /device/start refuses, so a device that falls back to the
 *   device-code flow fails at once instead of opening a browser. Each such
 *   request is counted: it is the flow a headless host cannot complete.
 * - GoTrue (/auth/v1): refresh tokens rotate on every refresh and are checked
 *   the way GoTrue checks them (supabase/auth, internal/tokens/service.go,
 *   RefreshTokenGrant):
 *     - the session's current token: a new one is issued, the old one is spent
 *     - the token just before the current one: the current one is handed back,
 *       nothing new is issued ("the client was not able to store the result")
 *     - any older token: "Invalid Refresh Token: Already Used", and the
 *       session is revoked
 *   GoTrue can also accept older tokens for a few seconds after a refresh
 *   (security.refresh_token_reuse_interval, set per project). That window is
 *   0 here unless a test sets it, so a quick restart cannot hide a token that
 *   is too old.
 *   Access tokens are JWTs that live `accessTtlSec` seconds.
 * - PostgREST (/rest/v1): the device's mcp_devices row and an empty
 *   mcp_remote_calls table, behind the access token.
 * - Realtime: the websocket is refused. The device then reports itself
 *   registered but not reachable, which is enough for the session under test.
 */

const USER = {
  id: '6b1a4a5e-0000-4000-8000-000000000695',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'device-owner@example.com',
  app_metadata: { provider: 'email' },
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
};

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function startRemoteStandIn({ accessTtlSec = 3600, reuseIntervalSec = 0 } = {}) {
  const deviceId = 'b6f0a1c2-0000-4000-8000-000000000695';
  const anonKey = 'stand-in-anon-key';
  /** session id -> { counter, tokens (by generation), revoked, lastRefreshedAt } */
  const sessions = new Map();
  /** refresh token -> { sessionId, generation } */
  const refreshTokens = new Map();
  let nextSessionId = 1;
  let failDeviceLookups = 0;
  let failRefreshes = 0;
  let failRefreshStatus = 500;
  /** Set by holdDeviceLookups(): { waiting: responders, arrived() } */
  let deviceLookupHold = null;

  const standIn = {
    url: '',
    anonKey,
    deviceId,
    userId: USER.id,
    /** Every refresh request, in order: { generation, outcome } */
    refreshes: [],
    /** Requests for the device-code flow */
    deviceFlowRequests: 0,
    /** Requests this stand-in has no answer for */
    unexpected: [],
    accessTtlSec,
    reuseIntervalSec,

    /**
     * A session as a completed device authorization hands it over.
     * accessExpiresInSec overrides the access token's lifetime; a negative
     * value gives one that has already expired (a device that was down longer
     * than that).
     */
    login({ accessExpiresInSec } = {}) {
      const sessionId = `session-${nextSessionId++}`;
      sessions.set(sessionId, { counter: 0, tokens: [], revoked: false, lastRefreshedAt: 0 });
      const refresh_token = issueRefreshToken(sessionId, 0);
      return { access_token: issueAccessToken(sessionId, accessExpiresInSec), refresh_token };
    },

    /** Generation of a refresh token within its session (0 = the one login issued), or -1 */
    generationOf(refreshToken) {
      return refreshTokens.get(refreshToken)?.generation ?? -1;
    },

    /** The session's current generation: how many times it has rotated */
    currentGeneration(refreshToken) {
      const known = refreshTokens.get(refreshToken);
      return known ? sessions.get(known.sessionId).counter : -1;
    },

    /** Refreshes that issued a new token */
    rotations() {
      return standIn.refreshes.filter((r) => r.outcome === 'rotated').length;
    },

    /** The next `count` device lookups answer with a server error */
    failDeviceLookups(count) {
      failDeviceLookups = count;
    },

    /** The next `count` refreshes answer `status` without rotating anything */
    failRefreshes(count, status = 500) {
      failRefreshes = count;
      failRefreshStatus = status;
    },

    /**
     * Device lookups get no answer until release(). A starting device looks its
     * saved device up after loading device.json and before saving it again, so
     * this holds it in between. `reached` resolves at the first held lookup.
     */
    holdDeviceLookups() {
      let reached;
      const hold = { waiting: [], reached: new Promise((resolve) => { reached = resolve; }) };
      hold.arrived = () => reached();
      deviceLookupHold = hold;
      return {
        reached: hold.reached,
        release() {
          if (deviceLookupHold === hold) deviceLookupHold = null;
          for (const respond of hold.waiting.splice(0)) respond();
        },
      };
    },

    /** One line for assertion messages */
    describe() {
      const outcomes = standIn.refreshes.map((r) => `${r.generation}:${r.outcome}`).join(' ') || 'none';
      return `refreshes (generation presented:outcome) ${outcomes}; device-code flow requests ${standIn.deviceFlowRequests}`
        + (standIn.unexpected.length ? `; unanswered ${standIn.unexpected.join(', ')}` : '');
    },

    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };

  function issueRefreshToken(sessionId, generation) {
    const token = `rt-${sessionId}-${generation}-${Math.random().toString(36).slice(2, 10)}`;
    sessions.get(sessionId).tokens[generation] = token;
    refreshTokens.set(token, { sessionId, generation });
    return token;
  }

  function issueAccessToken(sessionId, expiresInSec = standIn.accessTtlSec) {
    const iat = Math.floor(Date.now() / 1000);
    return [
      base64url({ alg: 'HS256', typ: 'JWT' }),
      base64url({ sub: USER.id, email: USER.email, aud: 'authenticated', role: 'authenticated', session_id: sessionId, iat, exp: iat + expiresInSec }),
      Buffer.from('stand-in-signature').toString('base64url'),
    ].join('.');
  }

  /** The session of a live access token from an Authorization header, or null */
  function sessionOfBearer(request) {
    const token = (request.headers.authorization || '').replace(/^Bearer /, '');
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const session = sessions.get(claims.session_id);
      if (!session || session.revoked || claims.exp * 1000 <= Date.now()) return null;
      return session;
    } catch {
      return null;
    }
  }

  function refresh(presented) {
    const known = refreshTokens.get(presented);
    const session = known && sessions.get(known.sessionId);
    const record = { generation: known ? known.generation : -1, outcome: '' };
    standIn.refreshes.push(record);

    if (!known) {
      record.outcome = 'not-found';
      return [400, { code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' }];
    }
    if (failRefreshes > 0) {
      failRefreshes--;
      record.outcome = `failed-${failRefreshStatus}`;
      return [failRefreshStatus, { code: 'unexpected_failure', message: 'stand-in: refresh failed on purpose' }];
    }

    const behind = session.counter - known.generation;
    const withinReuseInterval = Date.now() - session.lastRefreshedAt < standIn.reuseIntervalSec * 1000;
    if (session.revoked || (behind > 1 && !withinReuseInterval)) {
      session.revoked = true;
      record.outcome = 'already-used';
      return [400, { code: 'refresh_token_already_used', message: 'Invalid Refresh Token: Already Used' }];
    }
    if (behind === 0) {
      session.counter++;
      issueRefreshToken(known.sessionId, session.counter);
      record.outcome = 'rotated';
    } else {
      record.outcome = behind === 1 ? 'previous-accepted' : 'reuse-interval';
    }
    session.lastRefreshedAt = Date.now();
    const expiresAt = Math.floor(Date.now() / 1000) + standIn.accessTtlSec;
    return [200, {
      access_token: issueAccessToken(known.sessionId),
      token_type: 'bearer',
      expires_in: standIn.accessTtlSec,
      expires_at: expiresAt,
      refresh_token: session.tokens[session.counter],
      user: USER,
    }];
  }

  function handle(request, body) {
    const url = new URL(request.url, standIn.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /api/mcp-info') {
      return [200, { supabaseUrl: standIn.url, supabasePublishableKey: anonKey }];
    }
    if (route === 'POST /device/start' || route === 'POST /device/poll') {
      standIn.deviceFlowRequests++;
      return [503, { error_description: 'stand-in: the device-code flow needs a person at a browser' }];
    }
    if (route === 'POST /auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      return refresh(JSON.parse(body || '{}').refresh_token);
    }
    if (route === 'GET /auth/v1/user') {
      return sessionOfBearer(request)
        ? [200, USER]
        : [403, { code: 'bad_jwt', message: 'invalid JWT: token is expired or its session has ended' }];
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (!sessionOfBearer(request)) {
        return [401, { code: 'PGRST301', message: 'JWT expired', details: null, hint: null }];
      }
      const table = url.pathname.slice('/rest/v1/'.length);
      if (table === 'mcp_devices' && request.method === 'GET') {
        if (failDeviceLookups > 0) {
          failDeviceLookups--;
          return [500, { code: 'XX000', message: 'stand-in: device lookup failed on purpose', details: null, hint: null }];
        }
        return [200, [{ id: deviceId, device_name: 'stand-in-host' }]];
      }
      if (table === 'mcp_devices' && request.method === 'PATCH') {
        const representation = /return=representation/.test(request.headers.prefer || '');
        return representation ? [200, [{ id: deviceId, device_name: 'stand-in-host' }]] : [204, null];
      }
      if (table === 'mcp_remote_calls' && request.method === 'GET') {
        return [200, []];
      }
    }
    standIn.unexpected.push(route);
    return [404, { message: `stand-in: no route for ${route}` }];
  }

  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const respond = () => {
        const [status, payload] = handle(request, body);
        response.writeHead(status, {
          'Content-Type': 'application/json',
          // Error bodies carry `code`, the shape auth-js reads from API version 2024-01-01 on
          'X-Supabase-Api-Version': '2024-01-01',
        });
        response.end(payload === null ? undefined : JSON.stringify(payload));
      };
      const isDeviceLookup = request.method === 'GET' && new URL(request.url, standIn.url).pathname === '/rest/v1/mcp_devices';
      if (deviceLookupHold && isDeviceLookup) {
        deviceLookupHold.waiting.push(respond);
        deviceLookupHold.arrived();
        return;
      }
      respond();
    });
  });
  // Realtime is out of scope: refuse the websocket instead of leaving it hanging
  server.on('upgrade', (request, socket) => {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  standIn.url = `http://127.0.0.1:${server.address().port}`;
  return standIn;
}
