import { evaluateWithJev } from './provider.js';
import { configManager } from '../config-manager.js';
import { buildProjectionMetrics, sumTextStats, textStats, JEV_INPUT_PRICE_USD_PER_MILLION_TOKENS, type ProjectionMetrics } from './metrics.js';

export type ProjectionSelectOptions = {
  mode: 'select';
  instruction: string;
  minRelevance?: number;
  chunkLines?: number;
};

export type SelectedChunk = {
  index: number;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
};

function probabilityFromAnswer(answer: any): number {
  if (typeof answer?.noul === 'number') return answer.noul;
  if (typeof answer?.probability === 'number') return answer.probability;
  if (typeof answer?.value === 'number') return answer.value;
  if (typeof answer === 'number') return answer;
  return 0;
}

export async function selectRelevantLineChunks(
  text: string,
  projection: ProjectionSelectOptions,
  baseLine = 0
): Promise<{ selected: SelectedChunk[]; totalChunks: number; model?: string; metrics: ProjectionMetrics }> {
  const projectionStartedAt = performance.now();
  const lines = text.split(/\r?\n/);
  const chunkLines = Math.max(5, Math.min(200, projection.chunkLines ?? 40));
  const minRelevance = Math.max(0, Math.min(1, projection.minRelevance ?? 0.65));
  const chunks: Array<{ id: string; index: number; startLine: number; endLine: number; text: string }> = [];

  for (let i = 0; i < lines.length; i += chunkLines) {
    const slice = lines.slice(i, i + chunkLines);
    chunks.push({
      id: `chunk_${chunks.length}`,
      index: chunks.length,
      startLine: baseLine + i,
      endLine: baseLine + i + Math.max(0, slice.length - 1),
      text: slice.join('\n'),
    });
  }

  if (chunks.length === 0) {
    throw new Error('Semantic projection requires non-empty text.');
  }

  const questions = Object.fromEntries(chunks.map((chunk) => [
    chunk.id,
    {
      type: 'noul' as const,
      instructions: `Is the content in chunks[${chunk.index}].text useful for this task: "${projection.instruction}"? Answer based on direct relevance, evidence, or explanatory value. Do not reward mere keyword overlap.`,
      criteria: {
        true: 'Useful enough that the agent should inspect this chunk.',
        false: 'Not useful enough to spend expensive model context on it.',
      },
    },
  ]));

  const config = await configManager.getConfig();
  if (!config.semanticProjectionEnabled) {
    throw new Error('Semantic projection is disabled. Enable it in Desktop Commander settings first.');
  }

  const evaluation = await evaluateWithJev({
    state: {
      task: projection.instruction,
      chunks: chunks.map(({ index, startLine, endLine, text }) => ({ index, startLine, endLine, text })),
    },
    questions,
    model: config.semanticProjectionModel || 'jev-latest',
  });
  const response = evaluation.response;
  const answers = response?.answers ?? {};
  const ranked = chunks
    .map((chunk) => ({ ...chunk, score: probabilityFromAnswer(answers[chunk.id]) }))
    .filter((chunk) => chunk.score >= minRelevance)
    .sort((a, b) => b.score - a.score)
    .map(({ id: _id, ...chunk }) => chunk);

  const metrics = buildProjectionMetrics(
    textStats(text),
    sumTextStats(ranked.map((chunk) => chunk.text)),
    evaluation.metrics,
    performance.now() - projectionStartedAt,
  );

  return { selected: ranked, totalChunks: chunks.length, model: response?.model, metrics };
}

export type ProjectionCandidate = {
  id: string;
  label: string;
  text: string;
};

export async function selectRelevantCandidates(
  candidates: ProjectionCandidate[],
  projection: ProjectionSelectOptions
): Promise<{ selected: Array<ProjectionCandidate & { score: number }>; totalCandidates: number; metrics: ProjectionMetrics }> {
  const projectionStartedAt = performance.now();
  if (candidates.length === 0) {
    throw new Error('Semantic projection requires at least one candidate.');
  }
  const minRelevance = Math.max(0, Math.min(1, projection.minRelevance ?? 0.65));
  const config = await configManager.getConfig();
  if (!config.semanticProjectionEnabled) {
    throw new Error('Semantic projection is disabled. Enable it in Desktop Commander settings first.');
  }

  const workingCandidates = candidates.slice(0, 64).map((candidate) => {
    const maxChars = 12_000;
    const text = candidate.text.length <= maxChars
      ? candidate.text
      : `${candidate.text.slice(0, 6_000)}\n...[semantic projection sample clipped]...\n${candidate.text.slice(-6_000)}`;
    return { ...candidate, text };
  });

  const questions = Object.fromEntries(workingCandidates.map((candidate, index) => [
    `candidate_${index}`,
    {
      type: 'noul' as const,
      instructions: `Is candidates[${index}] useful for this task: "${projection.instruction}"? Judge direct relevance or explanatory value, not just keyword overlap.`,
      criteria: {
        true: 'Worth inspecting.',
        false: 'Not useful enough to inspect.',
      },
    },
  ]));

  const evaluation = await evaluateWithJev({
    state: {
      task: projection.instruction,
      candidates: workingCandidates.map((candidate, index) => ({ index, ...candidate })),
    },
    questions,
    model: config.semanticProjectionModel || 'jev-latest',
  });
  const response = evaluation.response;
  const answers = response?.answers ?? {};

  const selected = workingCandidates
    .map((candidate, index) => ({
      ...candidate,
      score: probabilityFromAnswer(answers[`candidate_${index}`]),
    }))
    .filter((candidate) => candidate.score >= minRelevance)
    .sort((a, b) => b.score - a.score);

  const metrics = buildProjectionMetrics(
    sumTextStats(workingCandidates.map((candidate) => candidate.text)),
    { lines: 0, chars: 0, bytes: 0 },
    evaluation.metrics,
    performance.now() - projectionStartedAt,
  );

  return { selected, totalCandidates: workingCandidates.length, metrics };
}


export type SelectedCorpusChunk = SelectedChunk & {
  candidateId: string;
  label: string;
};

export async function selectRelevantCorpusChunks(
  candidates: ProjectionCandidate[],
  projection: ProjectionSelectOptions
): Promise<{ selected: SelectedCorpusChunk[]; totalChunks: number; metrics: ProjectionMetrics }> {
  const projectionStartedAt = performance.now();
  if (candidates.length === 0) throw new Error('Semantic corpus projection requires at least one candidate.');
  const config = await configManager.getConfig();
  if (!config.semanticProjectionEnabled) throw new Error('Semantic projection is disabled. Enable it in Desktop Commander settings first.');

  const chunkLines = Math.max(5, Math.min(200, projection.chunkLines ?? 40));
  const minRelevance = Math.max(0, Math.min(1, projection.minRelevance ?? 0.65));
  const chunks: Array<SelectedCorpusChunk & { id: string }> = [];
  for (const candidate of candidates) {
    const lines = candidate.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += chunkLines) {
      const slice = lines.slice(i, i + chunkLines);
      chunks.push({ id: `chunk_${chunks.length}`, candidateId: candidate.id, label: candidate.label,
        index: chunks.length, startLine: i, endLine: i + Math.max(0, slice.length - 1), score: 0, text: slice.join('\n') });
    }
  }

  const selected: SelectedCorpusChunk[] = [];
  let requestBytes = 0, responseBytes = 0, inputTokens = 0, outputTokens = 0, estimatedCostUsd = 0, latencyMs = 0;
  let sawInputTokens = false, sawOutputTokens = false, sawCost = false;
  const MAX_BATCH_CHUNKS = 30;
  const MAX_BATCH_CHARS = 90_000;
  const batches: typeof chunks[] = [];
  let batch: typeof chunks = [], batchChars = 0;
  for (const chunk of chunks) {
    if (batch.length > 0 && (batch.length >= MAX_BATCH_CHUNKS || batchChars + chunk.text.length > MAX_BATCH_CHARS)) {
      batches.push(batch); batch = []; batchChars = 0;
    }
    batch.push(chunk); batchChars += chunk.text.length;
  }
  if (batch.length > 0) batches.push(batch);

  const evaluateBatch = async (current: typeof chunks) => {
    const questions = Object.fromEntries(current.map((chunk, index) => [`chunk_${index}`, {
      type: 'noul' as const,
      instructions: `Is corpusChunks[${index}].text useful for this task: "${projection.instruction}"? Answer based on direct relevance, evidence, or explanatory value. Do not reward mere keyword overlap.`,
      criteria: { true: 'Useful enough that the agent should inspect this chunk.', false: 'Not useful enough to spend expensive model context on it.' },
    }]));
    const evaluation = await evaluateWithJev({
      state: { task: projection.instruction, corpusChunks: current.map((chunk, index) => ({ index, file: chunk.label, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text })) },
      questions,
      model: config.semanticProjectionModel || 'jev-latest',
    });
    const batchSelected: SelectedCorpusChunk[] = [];
    const answers = evaluation.response?.answers ?? {};
    current.forEach((chunk, index) => {
      const score = probabilityFromAnswer(answers[`chunk_${index}`]);
      if (score >= minRelevance) { const { id: _id, ...rest } = chunk; batchSelected.push({ ...rest, score }); }
    });
    return { evaluation, batchSelected };
  };

  const MAX_CONCURRENT_BATCHES = 4;
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const wave = await Promise.all(batches.slice(i, i + MAX_CONCURRENT_BATCHES).map(evaluateBatch));
    for (const { evaluation, batchSelected } of wave) {
      selected.push(...batchSelected);
      requestBytes += evaluation.metrics.requestBytes; responseBytes += evaluation.metrics.responseBytes; latencyMs += evaluation.metrics.latencyMs;
      if (evaluation.metrics.inputTokens !== undefined) { sawInputTokens = true; inputTokens += evaluation.metrics.inputTokens; }
      if (evaluation.metrics.outputTokens !== undefined) { sawOutputTokens = true; outputTokens += evaluation.metrics.outputTokens; }
      if (evaluation.metrics.estimatedCostUsd !== undefined) { sawCost = true; estimatedCostUsd += evaluation.metrics.estimatedCostUsd; }
    }
  }

  // Progressive semantic zoom: if coarse relevant chunks still exceed a
  // reasonable host-context payload, re-chunk only those selected regions at
  // finer granularity and apply the SAME quality gate again. This is not a
  // top-N truncation: every fine chunk above minRelevance survives.
  const HOST_REFINEMENT_TRIGGER_BYTES = 50_000;
  let finalSelected = selected;
  for (const fineChunkLines of [20, 10, 5]) {
    if (sumTextStats(finalSelected.map((chunk) => chunk.text)).bytes <= HOST_REFINEMENT_TRIGGER_BYTES) break;
    const refinedChunks: typeof chunks = [];
    for (const parent of finalSelected) {
      const lines = parent.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += fineChunkLines) {
        const slice = lines.slice(i, i + fineChunkLines);
        refinedChunks.push({
          id: `refined_${fineChunkLines}_${refinedChunks.length}`,
          candidateId: parent.candidateId,
          label: parent.label,
          index: refinedChunks.length,
          startLine: parent.startLine + i,
          endLine: parent.startLine + i + Math.max(0, slice.length - 1),
          score: 0,
          text: slice.join('\n'),
        });
      }
    }

    const refinedBatches: typeof chunks[] = [];
    let refinedBatch: typeof chunks = [], refinedBatchChars = 0;
    for (const chunk of refinedChunks) {
      if (refinedBatch.length > 0 && (refinedBatch.length >= MAX_BATCH_CHUNKS || refinedBatchChars + chunk.text.length > MAX_BATCH_CHARS)) {
        refinedBatches.push(refinedBatch); refinedBatch = []; refinedBatchChars = 0;
      }
      refinedBatch.push(chunk); refinedBatchChars += chunk.text.length;
    }
    if (refinedBatch.length > 0) refinedBatches.push(refinedBatch);

    const refinedSelected: SelectedCorpusChunk[] = [];
    for (let i = 0; i < refinedBatches.length; i += MAX_CONCURRENT_BATCHES) {
      const wave = await Promise.all(refinedBatches.slice(i, i + MAX_CONCURRENT_BATCHES).map(evaluateBatch));
      for (const { evaluation, batchSelected } of wave) {
        refinedSelected.push(...batchSelected);
        requestBytes += evaluation.metrics.requestBytes; responseBytes += evaluation.metrics.responseBytes; latencyMs += evaluation.metrics.latencyMs;
        if (evaluation.metrics.inputTokens !== undefined) { sawInputTokens = true; inputTokens += evaluation.metrics.inputTokens; }
        if (evaluation.metrics.outputTokens !== undefined) { sawOutputTokens = true; outputTokens += evaluation.metrics.outputTokens; }
        if (evaluation.metrics.estimatedCostUsd !== undefined) { sawCost = true; estimatedCostUsd += evaluation.metrics.estimatedCostUsd; }
      }
    }
    finalSelected = refinedSelected;
  }

  finalSelected.sort((a, b) => b.score - a.score);
  const sourceStats = sumTextStats(candidates.map((candidate) => candidate.text));
  const exposedStats = sumTextStats(finalSelected.map((chunk) => chunk.text));
  const withheldFromHost = { lines: Math.max(0, sourceStats.lines - exposedStats.lines), chars: Math.max(0, sourceStats.chars - exposedStats.chars), bytes: Math.max(0, sourceStats.bytes - exposedStats.bytes) };
  const exposedPercent = sourceStats.bytes > 0 ? exposedStats.bytes / sourceStats.bytes * 100 : 0;
  const metrics: ProjectionMetrics = {
    source: sourceStats, exposedToHost: exposedStats, withheldFromHost, exposedPercent, withheldPercent: sourceStats.bytes > 0 ? 100 - exposedPercent : 0,
    jev: { latencyMs, requestBytes, responseBytes, inputTokens: sawInputTokens ? inputTokens : undefined, outputTokens: sawOutputTokens ? outputTokens : undefined,
      estimatedCostUsd: sawCost ? estimatedCostUsd : undefined, inputPriceUsdPerMillionTokens: JEV_INPUT_PRICE_USD_PER_MILLION_TOKENS },
    totalProjectionMs: performance.now() - projectionStartedAt,
  };
  return { selected: finalSelected, totalChunks: chunks.length, metrics };
}
