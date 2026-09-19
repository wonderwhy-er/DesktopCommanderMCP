import { getSemanticProjectionApiKey } from './secrets.js';
import { JEV_INPUT_PRICE_USD_PER_MILLION_TOKENS, type JevCallMetrics } from './metrics.js';

export type JevQuestion = {
  type: 'noul' | 'choice' | 'score';
  instructions: unknown;
  criteria?: unknown;
};

export type JevRequest = {
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
};

export type JevEvaluationResult = {
  response: any;
  metrics: JevCallMetrics;
};

export async function evaluateWithJev(request: JevRequest): Promise<JevEvaluationResult> {
  const apiKey = await getSemanticProjectionApiKey();
  if (!apiKey) {
    throw new Error(
      'Semantic projection is not configured. Set a TypeSafe API key in Desktop Commander settings or configure it from a local file through set_config_value.'
    );
  }

  const requestBody = JSON.stringify({
    ...request,
    model: request.model || 'jev-latest',
  });
  const startedAt = performance.now();
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: requestBody,
    signal: AbortSignal.timeout(60_000),
  });
  const latencyMs = performance.now() - startedAt;

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jev request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  const parsed = JSON.parse(text);
  const inputTokens = typeof parsed?.usage?.input_tokens === 'number'
    ? parsed.usage.input_tokens
    : undefined;
  const outputTokens = typeof parsed?.usage?.output_tokens === 'number'
    ? parsed.usage.output_tokens
    : undefined;
  const estimatedCostUsd = inputTokens === undefined
    ? undefined
    : inputTokens * JEV_INPUT_PRICE_USD_PER_MILLION_TOKENS / 1_000_000;

  return {
    response: parsed,
    metrics: {
      latencyMs,
      requestBytes: Buffer.byteLength(requestBody, 'utf8'),
      responseBytes: Buffer.byteLength(text, 'utf8'),
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      inputPriceUsdPerMillionTokens: JEV_INPUT_PRICE_USD_PER_MILLION_TOKENS,
    },
  };
}
