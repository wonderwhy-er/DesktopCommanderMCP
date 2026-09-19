import { getSemanticProjectionApiKey } from './secrets.js';

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

export async function evaluateWithJev(request: JevRequest): Promise<any> {
  const apiKey = await getSemanticProjectionApiKey();
  if (!apiKey) {
    throw new Error(
      'Semantic projection is not configured. Set a TypeSafe API key in Desktop Commander settings or import one from a file.'
    );
  }

  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...request,
      model: request.model || 'jev-latest',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jev request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}
