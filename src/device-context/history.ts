/**
 * Device context — compact `get_recent_tool_calls`: one line per call (time, tool, key argument, outcome)
 * instead of full arguments and outputs. Called by the history handler on the calls themselves, before
 * anything else (feedback or Docker prompts) is added to the result text. `format: "full"` keeps the old view.
 */
import { redact } from './privacy.js';
import { failedOutput, resultText } from './observe.js';

const PROCESS_TOOLS = new Set(['start_process', 'interact_with_process', 'read_process_output']);

/** Key argument of a call, as short plain text (paths and commands only; secrets redacted). */
function keyArg(tool: string, a: any): string {
    if (!a || typeof a !== 'object') return '';
    const pick = a.path ?? a.file_path ?? (Array.isArray(a.paths) ? a.paths.slice(0, 3).join(', ') + (a.paths.length > 3 ? ` +${a.paths.length - 3}` : '') : undefined)
        ?? (a.source ? `${a.source} -> ${a.destination}` : undefined)
        ?? a.command ?? a.input ?? (a.pid !== undefined ? `pid ${a.pid}` : undefined) ?? a.pattern ?? a.sessionId ?? a.key ?? '';
    const extra = tool === 'start_search' && a.pattern && pick !== a.pattern ? ` "${a.pattern}"` : '';
    const one = redact(String(pick) + extra).replace(/\s+/g, ' ').trim();
    return one.length > 110 ? one.slice(0, 109) + '…' : one;
}

/** What happened, in a few words: ok, error with its first line, or a crash for processes. */
function outcome(tool: string, out: any): string {
    const text = resultText(out);
    const firstLine = (re: RegExp) => redact((text.split('\n').find((l: string) => re.test(l)) ?? '').trim()).slice(0, 90);
    if (out?.isError) return `ERROR ${firstLine(/\S/) || ''}`.trim();
    if (PROCESS_TOOLS.has(tool) && failedOutput(text)) {
        const why = firstLine(/(Error|Exception|ENOENT|EADDRINUSE|exit code|not found|not recognized)/i);
        return `failed${why ? ': ' + why : ''}`;
    }
    const stop = text.match(/exit code (130|143)\b/);
    if (stop && PROCESS_TOOLS.has(tool)) return `stopped (exit ${stop[1]})`;
    if (tool === 'start_process' && /Process is running/.test(text)) return 'running';
    return 'ok';
}

/** The history answer in compact form: the summary line, then one line per call. */
export function compactCalls(summary: string, calls: any[]): string {
    const lines = calls.map((c) => {
        const when = String(c?.timestamp ?? '').replace('T', ' ').replace(/:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, '');
        const tool = String(c?.toolName ?? '?');
        const arg = keyArg(tool, c?.arguments);
        return `${when} ${tool}${arg ? ' ' + arg : ''} -> ${outcome(tool, c?.output)}`;
    });
    return `${summary.trim()} (compact: one line per call; arguments and outputs left out. Full: get_recent_tool_calls with format "full", or read the files themselves)\n${lines.join('\n')}`;
}
