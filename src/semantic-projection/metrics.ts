// Published TypeSafe Jev early-access input rate as of 2026-09-15.
// Cost is estimated locally from provider-reported input tokens; the API does not return dollars.
export const JEV_INPUT_PRICE_USD_PER_MILLION_TOKENS = 0.042;

export type TextStats = {
  lines: number;
  chars: number;
  bytes: number;
};

export type JevCallMetrics = {
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  inputPriceUsdPerMillionTokens: number;
};

export type ProjectionMetrics = {
  source: TextStats;
  exposedToHost: TextStats;
  withheldFromHost: TextStats;
  exposedPercent: number;
  withheldPercent: number;
  jev: JevCallMetrics;
  totalProjectionMs: number;
};

export function textStats(text: string): TextStats {
  return {
    lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

export function sumTextStats(texts: string[]): TextStats {
  return texts.reduce<TextStats>((sum, text) => {
    const stats = textStats(text);
    return {
      lines: sum.lines + stats.lines,
      chars: sum.chars + stats.chars,
      bytes: sum.bytes + stats.bytes,
    };
  }, { lines: 0, chars: 0, bytes: 0 });
}

export function buildProjectionMetrics(
  source: TextStats,
  exposedToHost: TextStats,
  jev: JevCallMetrics,
  totalProjectionMs: number,
): ProjectionMetrics {

  const withheldFromHost: TextStats = {
    lines: Math.max(0, source.lines - exposedToHost.lines),
    chars: Math.max(0, source.chars - exposedToHost.chars),
    bytes: Math.max(0, source.bytes - exposedToHost.bytes),
  };
  const exposedPercent = source.bytes > 0
    ? (exposedToHost.bytes / source.bytes) * 100
    : 0;
  const withheldPercent = source.bytes > 0
    ? 100 - exposedPercent
    : 0;

  return {
    source,
    exposedToHost,
    withheldFromHost,
    exposedPercent,
    withheldPercent,
    jev,
    totalProjectionMs,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return 'unavailable';
  if (cost === 0) return '$0';
  if (cost < 0.000001) return `$${cost.toExponential(2)}`;
  return `$${cost.toFixed(6)}`;
}

export function formatProjectionMetrics(metrics: ProjectionMetrics): string {
  const inputTokens = metrics.jev.inputTokens === undefined
    ? 'unavailable'
    : metrics.jev.inputTokens.toLocaleString();
  const outputTokens = metrics.jev.outputTokens === undefined
    ? 'unavailable'
    : metrics.jev.outputTokens.toLocaleString();

  return [
    'Projection metrics:',
    `- Source considered: ${metrics.source.lines.toLocaleString()} lines, ${formatBytes(metrics.source.bytes)}`,
    `- Source exposed to host LLM: ${metrics.exposedToHost.lines.toLocaleString()} lines, ${formatBytes(metrics.exposedToHost.bytes)} (${metrics.exposedPercent.toFixed(1)}%)`,
    `- Source withheld from host LLM: ${metrics.withheldFromHost.lines.toLocaleString()} lines, ${formatBytes(metrics.withheldFromHost.bytes)} (${metrics.withheldPercent.toFixed(1)}%)`,
    `- Jev payload: ${formatBytes(metrics.jev.requestBytes)} request, ${formatBytes(metrics.jev.responseBytes)} response`,
    `- Jev usage: ${inputTokens} input tokens, ${outputTokens} output tokens, estimated cost ${formatCost(metrics.jev.estimatedCostUsd)} @ $${metrics.jev.inputPriceUsdPerMillionTokens}/MTok input`,
    `- Timing: Jev ${metrics.jev.latencyMs.toFixed(0)} ms, total projection ${metrics.totalProjectionMs.toFixed(0)} ms`,
  ].join('\n');
}
