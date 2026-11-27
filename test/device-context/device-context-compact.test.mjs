// get_recent_tool_calls in nudge/both mode: compacted by the history handler (on the calls, before any other
// prompt is added to the text), and the card as its own block on top.
import path from 'path';
import { setup, mk, ok, checker } from './harness.mjs';

const t = await setup({ prefix: 'dc5-', mode: 'nudge' });
const { H, dc, nudge } = t;
const { check, done } = checker();
const shop = mk(path.join(H, 'code', 'shop'), { 'package.json': '{"name":"shop"}' });
t.writeJournal([{ t: new Date(Date.now() - 86400e3).toISOString(), origin: 'local', root: shop, kind: 'edit', file: '.env' }]);
const calls = [
  { timestamp: '11/21/2026, 14:10:20', toolName: 'edit_block', arguments: { file_path: path.join(shop, '.env'), old_string: 'A', new_string: 'SECRET_CONTENT_LINE' }, output: { content: [{ type: 'text', text: 'ok' }] } },
  { timestamp: '11/21/2026, 14:11:02', toolName: 'start_process', arguments: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x' }, output: { content: [{ type: 'text', text: 'Process completed with exit code 7' }] } },
];
const summary = 'Tool Call History (2 results, 2 total in memory)';
const compact = dc.compactHistoryIfEnabled(summary, calls, undefined);
check('compact: one line per call under the summary', compact?.split('\n').length === 3 && compact.startsWith(summary), compact);
check('compact: time, tool, key argument, outcome', /11\/21\/2026, 14:10 edit_block .*\.env -> ok/.test(compact) && /start_process .* -> failed/.test(compact), compact);
check('compact: no file contents, secrets redacted', !compact.includes('SECRET_CONTENT_LINE') && !compact.includes('abcdefghijklmnop'), compact);
check('format "full": left to the handler as it was', dc.compactHistoryIfEnabled(summary, calls, 'full') === null);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'tool';
check('tool-only mode: not compacted', dc.compactHistoryIfEnabled(summary, calls, undefined) === null);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'off';
check('feature off: not compacted', dc.compactHistoryIfEnabled(summary, calls, undefined) === null);

process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'nudge'; nudge._resetEpisodesForTests();
// a feedback prompt glued to the text after compaction cannot undo it any more (the old hook re-parsed the text)
const raw = ok(`${compact}\n\n[feedback prompt appended by another hook]`);
const r1 = dc.maybeAppendDeviceContext('get_recent_tool_calls', { maxResults: 50 }, raw, {});
check('card on top as its own block, history (with what others added) kept below', r1.content.length === 2 && r1.content[0].text.startsWith('💡 Recent work on this device') && r1.content[1] === raw.content[0], r1.content);
const r2 = dc.maybeAppendDeviceContext('get_recent_tool_calls', {}, raw, {});
check('second call within a minute: no second card', r2 === raw, r2.content);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'off';
check('feature off: history result untouched', dc.maybeAppendDeviceContext('get_recent_tool_calls', {}, raw, {}) === raw);
done();
