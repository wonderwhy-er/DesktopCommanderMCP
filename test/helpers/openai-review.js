/** Bounded, API-key-only Responses loop. Authentication never uses a local agent login. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readTool, readTools } from './review-tools.js';

function reviewState({ prompt, key, model, effort, token, endpoint, out }) {
  if (!key) throw new Error('No OpenAI API key: nothing was reviewed.');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error('Unsupported review reasoning effort.');
  }
  const url = new URL(endpoint);
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (endpoint !== 'https://api.openai.com/v1/responses' && !loopback) {
    throw new Error('Review endpoint must be OpenAI Responses or a loopback test server.');
  }
  const secrets = [
    key,
    ...(token?.length >= 8 ? [token] : []),
    ...Object.entries(process.env)
      .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && value.length >= 8)
      .map(([, value]) => value),
  ];
  const redact = (text) =>
    [...new Set(secrets)].reduce((value, secret) => value.split(secret).join('<redacted>'), String(text));
  if (redact(prompt) !== prompt) throw new Error('Review input contains a credential: no request was sent.');
  const save = (name, value) => {
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, name), redact(value));
  };
  const metrics = {
    api: { totalRequests: 0, totalLatencyMs: 0 },
    tokens: { prompt: 0, candidates: 0, thoughts: 0, total: 0 },
  };
  return {
    redact,
    save,
    metrics,
    stats: { models: { [model]: metrics } },
    used: 0,
    limits: [],
    history: [{ role: 'user', content: prompt }],
    session: [],
    controller: new AbortController(),
    started: Date.now(),
  };
}

function countUsage(metrics, usage = {}) {
  const thoughts = usage.output_tokens_details?.reasoning_tokens ?? 0;
  metrics.tokens.prompt += usage.input_tokens ?? 0;
  metrics.tokens.candidates += Math.max(0, (usage.output_tokens ?? 0) - thoughts);
  metrics.tokens.thoughts += thoughts;
  metrics.tokens.total += usage.total_tokens ?? 0;
}

const ERROR_CODES = new Set([
  'rate_limit_exceeded',
  'slow_down',
  'insufficient_quota',
  'insufficient_credits',
  'invalid_api_key',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'billing_hard_limit_reached',
  'model_not_found',
  'server_is_overloaded',
]);
const ERROR_TYPES = new Set([
  'rate_limit_error',
  'insufficient_quota',
  'invalid_request_error',
  'authentication_error',
  'service_unavailable_error',
  'server_error',
  'tokens',
  'requests',
  'project_tokens',
]);
const ERROR_PARAMS = new Set([
  'input',
  'model',
  'max_output_tokens',
  'reasoning',
  'reasoning.effort',
  'tools',
  'tool_choice',
  'store',
  'include',
  'parallel_tool_calls',
  'text',
  'text.format',
]);

function errorField(value, allowed, redact) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return 'unknown';
  if (redact(value) !== value) return '<redacted>';
  return allowed.has(value) ? value : 'unknown';
}

function milliseconds(value, retryAfter) {
  if (typeof value !== 'string' || value.length > 80) return null;
  if (retryAfter && /^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (parts.length && parts.map((part) => part[0]).join('') === value) {
    return parts.reduce((total, part) => total + Number(part[1]) * units[part[2]], 0);
  }
  if (retryAfter && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), .{20} GMT$/.test(value)) {
    const when = Date.parse(value);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  return null;
}

function rateHeaders(response, redact) {
  const headers = {};
  const waits = [];
  for (const scope of ['requests', 'tokens', 'project-tokens']) {
    for (const kind of ['limit', 'remaining', 'reset']) {
      const name = `x-ratelimit-${kind}-${scope}`;
      const value = response.headers?.get(name);
      if (!value) continue;
      if (redact(value) !== value) {
        headers[name] = '<redacted>';
        continue;
      }
      const reset = kind === 'reset' ? milliseconds(value, false) : null;
      if (Number.isFinite(reset) && reset >= 0) {
        headers[name] = value;
        waits.push(reset);
      } else if (kind !== 'reset' && /^\d{1,15}$/.test(value)) headers[name] = Number(value);
    }
  }
  const value = response.headers?.get('retry-after');
  if (value && redact(value) !== value) headers['retry-after'] = '<redacted>';
  else {
    const wait = milliseconds(value, true);
    if (Number.isFinite(wait) && wait >= 0) {
      headers['retry-after'] = value;
      waits.push(wait);
    }
  }
  return { headers, minimumDelayMs: waits.length ? Math.max(...waits) : null };
}

async function rateError(response, state, operation) {
  let fields = {};
  try {
    fields = (await response.json())?.error ?? {};
  } catch {
    /* A non-JSON provider error is unknown and is never automatically retried. */
  }
  const rates = rateHeaders(response, state.redact);
  const diagnostic = {
    status: response.status,
    operation,
    attempt: state.metrics.api.totalRequests,
    type: errorField(fields.type, ERROR_TYPES, state.redact),
    code: errorField(fields.code, ERROR_CODES, state.redact),
    param: errorField(fields.param, ERROR_PARAMS, state.redact),
    ...rates,
  };
  state.limits.push(diagnostic);
  state.save('rate-limits.json', JSON.stringify(state.limits, null, 2) + '\n');
  return diagnostic;
}

function limitFailure(diagnostic, reason = '') {
  return new Error(
    `OpenAI Responses stopped (HTTP ${diagnostic.status}): ${JSON.stringify(diagnostic)}${reason ? `; ${reason}` : ''}. No review was written.`,
  );
}

async function sendRequest(options, state, request) {
  const operation = request.headers['X-Client-Request-Id'];
  for (let retry = 0; ; retry += 1) {
    if (state.metrics.api.totalRequests >= options.maxTurns) throw new Error('OpenAI review request budget exhausted.');
    const requested = Date.now();
    state.metrics.api.totalRequests += 1;
    const response = await options.fetchImpl(options.endpoint, request);
    state.metrics.api.totalLatencyMs += Date.now() - requested;
    if (response.ok) return response;
    const diagnostic = await rateError(response, state, operation);
    const transient =
      response.status === 429 &&
      ['rate_limit_exceeded', 'slow_down'].includes(diagnostic.code) &&
      ['rate_limit_error', 'tokens', 'requests', 'project_tokens', 'invalid_request_error'].includes(diagnostic.type);
    if (!transient) throw limitFailure(diagnostic);
    if (state.metrics.api.totalRequests >= options.maxTurns) throw limitFailure(diagnostic, 'request budget exhausted');
    const baseline = diagnostic.minimumDelayMs ?? Math.min(60_000, 1000 * 2 ** retry);
    const wait = baseline + Math.floor(Math.max(0, Math.min(1, options.random())) * 250);
    if (wait >= options.timeoutMs - (Date.now() - state.started))
      throw limitFailure(diagnostic, 'provider reset exceeds remaining deadline');
    diagnostic.retryDelayMs = wait;
    state.save('rate-limits.json', JSON.stringify(state.limits, null, 2) + '\n');
    await options.sleepImpl(wait, state.controller.signal);
  }
}

async function requestResponse(options, state) {
  const { key, model, effort, shell, calls, timeoutMs } = options;
  if (Date.now() - state.started >= timeoutMs) state.controller.abort();
  const response = await sendRequest(options, state, {
    method: 'POST',
    redirect: 'error',
    signal: state.controller.signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Client-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      model,
      reasoning: { effort },
      store: false,
      input: state.history,
      tools: readTools(shell),
      tool_choice: state.used >= calls ? 'none' : 'auto',
      parallel_tool_calls: false,
      max_output_tokens: 12_000,
      include: ['reasoning.encrypted_content'],
      text: { format: { type: 'json_object' } },
    }),
  });
  const body = await response.json();
  const encoded = JSON.stringify(body);
  if (state.redact(encoded) !== encoded)
    throw new Error('The model response contains a credential: no review was written.');
  state.session.push(body);
  state.save('session.jsonl', state.session.map((item) => JSON.stringify(item)).join('\n') + '\n');
  countUsage(state.metrics, body.usage);
  if (body.status !== 'completed' || !Array.isArray(body.output)) {
    throw new Error('OpenAI response was incomplete: no review was written.');
  }
  return body;
}

async function toolOutputs(options, state, body) {
  // Replay every output item, including reasoning, with each function result's original call_id.
  state.history.push(...body.output);
  for (const call of body.output.filter((item) => item.type === 'function_call')) {
    state.used += 1;
    let output = `Tool denied: reading budget used (${options.calls} calls). Answer now with JSON only.`;
    if (state.used <= options.calls) {
      try {
        output = await readTool({
          ...options,
          name: call.name,
          args: JSON.parse(call.arguments),
          timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - state.started)),
        });
      } catch {
        // Invalid tool JSON is refused without spending another request on a retry.
        output = 'Tool denied: invalid arguments.';
      }
    }
    state.history.push({ type: 'function_call_output', call_id: call.call_id, output: state.redact(output) });
  }
}

function finalAnswer(body, state) {
  const response = body.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('');
  if (!response) throw new Error('OpenAI returned no review answer.');
  const answer = { response, stats: state.stats };
  state.save('answer.json', JSON.stringify(answer, null, 2) + '\n');
  return answer;
}

export async function askResponses(given) {
  const options = {
    model: 'gpt-6.1-sol',
    effort: 'medium',
    calls: 8,
    maxTurns: 20,
    timeoutMs: 12 * 60 * 1000,
    shell: false,
    fetchImpl: fetch,
    random: Math.random,
    sleepImpl: (ms, signal) => delay(ms, null, { signal }),
    endpoint: 'https://api.openai.com/v1/responses',
    ...given,
  };
  const state = reviewState(options);
  const timer = setTimeout(() => state.controller.abort(), options.timeoutMs);
  try {
    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      const body = await requestResponse(options, state);
      if (!body.output.some((item) => item.type === 'function_call')) return finalAnswer(body, state);
      await toolOutputs(options, state, body);
    }
    throw new Error(`OpenAI used all ${options.maxTurns} turns without an answer: no review was written.`);
  } catch (error) {
    state.save(
      'answer.json',
      JSON.stringify({ error: state.redact(error.message), stats: state.stats }, null, 2) + '\n',
    );
    if (state.controller.signal.aborted) {
      throw new Error(
        `OpenAI didn't answer within ${Math.round(options.timeoutMs / 1000)} s: the request was stopped.`,
      );
    }
    throw new Error(state.redact(error.message));
  } finally {
    clearTimeout(timer);
  }
}
