import { EventEmitter } from 'events';
import https from 'https';
import { syncBuiltinESMExports } from 'module';

/**
 * Capture this test process's JSON telemetry payloads without network access.
 * Call before importing the server or capture module, so both use this request hook.
 */
export function captureTelemetryRequests(onMissingResponseCallback = () => {}) {
  const sent = [];
  /** Supply the writable request and successful response expected by the sender. */
  https.request = (url, options, callback) => {
    if (typeof options === 'function' && callback === undefined) callback = options;
    if (typeof callback !== 'function') onMissingResponseCallback();
    const chunks = [];
    const req = new EventEmitter();
    req.write = (data) => { chunks.push(String(data)); return true; };
    req.setTimeout = () => req;
    req.destroy = () => {};
    /** Record the complete body before acknowledging its delivery to the sender. */
    req.end = () => {
      sent.push(JSON.parse(chunks.join('')));
      const res = new EventEmitter();
      res.statusCode = 204;
      res.resume = () => res;
      callback?.(res);
      setImmediate(() => res.emit('end'));
    };
    return req;
  };
  syncBuiltinESMExports();
  return sent;
}
