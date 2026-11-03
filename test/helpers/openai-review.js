/** Bounded, API-key-only Responses loop. Authentication never uses a local agent login. */
import fs from 'node:fs';
import path from 'node:path';
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

async function requestResponse(options, state) {
  const { endpoint, key, model, effort, shell, calls, timeoutMs, fetchImpl } = options;
  if (Date.now() - state.started >= timeoutMs) state.controller.abort();
  const requested = Date.now();
  state.metrics.api.totalRequests += 1;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: state.controller.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
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
  state.metrics.api.totalLatencyMs += Date.now() - requested;
  // Never include a server's error body, which could echo authorization headers.
  if (!response.ok) throw new Error(`OpenAI Responses stopped (HTTP ${response.status}): no review was written.`);
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
