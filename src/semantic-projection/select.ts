import { evaluateWithJev } from './provider.js';
import { configManager } from '../config-manager.js';

export type ProjectionSelectOptions = {
  mode: 'select';
  instruction: string;
  limit?: number;
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
): Promise<{ selected: SelectedChunk[]; totalChunks: number; model?: string }> {
  const lines = text.split(/\r?\n/);
  const chunkLines = Math.max(5, Math.min(200, projection.chunkLines ?? 40));
  const limit = Math.max(1, Math.min(20, projection.limit ?? 5));
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

  if (chunks.length === 0) return { selected: [], totalChunks: 0 };

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

  const response = await evaluateWithJev({
    state: {
      task: projection.instruction,
      chunks: chunks.map(({ index, startLine, endLine, text }) => ({ index, startLine, endLine, text })),
    },
    questions,
    model: config.semanticProjectionModel || 'jev-latest',
  });

  const answers = response?.answers ?? {};
  const ranked = chunks
    .map((chunk) => ({ ...chunk, score: probabilityFromAnswer(answers[chunk.id]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ id: _id, ...chunk }) => chunk);

  return { selected: ranked, totalChunks: chunks.length, model: response?.model };
}

export type ProjectionCandidate = {
  id: string;
  label: string;
  text: string;
};

export async function selectRelevantCandidates(
  candidates: ProjectionCandidate[],
  projection: ProjectionSelectOptions
): Promise<Array<ProjectionCandidate & { score: number }>> {
  if (candidates.length === 0) return [];
  const limit = Math.max(1, Math.min(20, projection.limit ?? 5));
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

  const response = await evaluateWithJev({
    state: {
      task: projection.instruction,
      candidates: workingCandidates.map((candidate, index) => ({ index, ...candidate })),
    },
    questions,
    model: config.semanticProjectionModel || 'jev-latest',
  });
  const answers = response?.answers ?? {};

  return workingCandidates
    .map((candidate, index) => ({
      ...candidate,
      score: probabilityFromAnswer(answers[`candidate_${index}`]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
