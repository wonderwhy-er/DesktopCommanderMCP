/**
 * Module hooks for the install scripts' tests (helpers/install-script.js): the
 * scripts' https and child_process are stand-ins. Each telemetry post and each
 * command is written to a log and answered as DC_STAND_INS (JSON) says; nothing
 * reaches the network or another process. A command with no answer gets an
 * error, as a missing one would: never the real thing.
 */
const STAND_INS = {
  https: 'https',
  'node:https': 'https',
  child_process: 'child_process',
  'node:child_process': 'child_process',
};

// The answers for posts: per event name, one answer or a list used in turn (the last one repeats);
// ok (200), status (500), error, hang (no answer), response-error, close (cut before its end)
const HTTPS = `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
const { log, telemetry = {} } = JSON.parse(process.env.DC_STAND_INS);
const asked = new Map();
function answerFor(event) {
  const planned = telemetry.byEvent?.[event] ?? telemetry.default ?? 'ok';
  if (!Array.isArray(planned)) return planned;
  const turn = asked.get(event) ?? 0;
  asked.set(event, turn + 1);
  return planned[Math.min(turn, planned.length - 1)];
}
function respond(req, answer) {
  if (answer === 'error') return req.emit('error', new Error('stand-in: no network'));
  if (answer === 'hang') return undefined;
  const res = new EventEmitter();
  res.statusCode = answer === 'status' ? 500 : 200;
  req.emit('response', res);
  if (answer === 'response-error') return res.emit('error', new Error('stand-in: cut off'));
  if (answer === 'close') return res.emit('close');
  res.emit('data', '{}');
  res.emit('end');
  return res.emit('close');
}
export function request(url) {
  const req = new EventEmitter();
  let body = '';
  req.write = (chunk) => { body += chunk; return true; };
  req.destroy = () => { req.destroyed = true; };
  req.end = () => {
    let event = null;
    try { event = JSON.parse(body).events?.[0]?.name ?? null; } catch {}
    const answer = answerFor(event);
    fs.appendFileSync(log, JSON.stringify({ post: String(url), event, answer, body }) + '\\n');
    setImmediate(() => respond(req, answer));
  };
  return req;
}
export default { request };
`;

// The answers for commands: by the start of the command (cmd.exe /c left out): { stdout }, { error }, { throw }
// to throw at once; { uncaught } / { unhandled } answer as told and then raise an error or a rejection
// nothing catches; with no answer, an error
const CHILD_PROCESS = `
import fs from 'node:fs';
const { log, commands = {} } = JSON.parse(process.env.DC_STAND_INS);
function answerFor(command) {
  const asked = command.replace(/^cmd\\.exe \\/c /, '');
  const key = Object.keys(commands).find((start) => asked.startsWith(start));
  fs.appendFileSync(log, JSON.stringify({ command }) + '\\n');
  return key ? commands[key] : { error: 'stand-in: no answer for ' + asked };
}
export function execSync(command) {
  const answer = answerFor(command);
  if (answer.error || answer.throw) throw Object.assign(new Error(answer.error || answer.throw), { status: 1 });
  return answer.stdout ?? '';
}
export function exec(command, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const answer = answerFor(command);
  if (answer.throw) throw new Error(answer.throw);
  if (answer.uncaught) setImmediate(() => { throw new Error(answer.uncaught); });
  if (answer.unhandled) setImmediate(() => { Promise.reject(new Error(answer.unhandled)); });
  setImmediate(() => (answer.error
    ? done(Object.assign(new Error(answer.error), { code: 1 }), '', answer.error)
    : done(null, answer.stdout ?? '', '')));
  return { pid: 0 };
}
export default { exec, execSync };
`;

export async function resolve(specifier, context, next) {
  const name = STAND_INS[specifier];
  if (name) return { url: `dc-stand-in:${name}`, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === 'dc-stand-in:https') return { format: 'module', source: HTTPS, shortCircuit: true };
  if (url === 'dc-stand-in:child_process') return { format: 'module', source: CHILD_PROCESS, shortCircuit: true };
  return next(url, context);
}
