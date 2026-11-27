// get_config gets the card; the mode and the allowlist come from DC's config; the readable context file.
import fs from 'fs'; import path from 'path';
import { setup, mk, ok, checker, notesIn } from './harness.mjs';

const t = await setup({ prefix: 'dc6-', mode: 'nudge' });
const { H, dc, nudge, settings } = t;
const { check, section, done } = checker();
const shop = mk(path.join(H, 'code', 'shop'), { 'package.json': '{"name":"shop"}' });
t.writeJournal([{ t: new Date(Date.now() - 86400e3).toISOString(), origin: 'local', root: shop, kind: 'edit', file: '.env' }]);
const cfg = ok('{ "blockedCommands": [] }');

section('get_config');
const r1 = dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
check('get_config: own output first, then the note', r1.content.length === 2 && r1.content[0].text === '{ "blockedCommands": [] }' && r1.content[1].text.startsWith('💡 Recent work on this device') && r1.content[1].text.includes(shop), r1.content);
check('original result untouched', cfg.content.length === 1 && cfg.content[0].text === '{ "blockedCommands": [] }');
const r2 = dc.maybeAppendDeviceContext('list_directory', { path: H }, ok('[DIR] code'), {});
check('exploring right after get_config: no second note (in any block)', r2.content.length === 1 && notesIn(r2) === 0, r2.content);
const r3 = dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
check('second get_config in the same chat: no note (in any block)', r3.content.length === 1 && notesIn(r3) === 0, r3.content);
nudge._resetEpisodesForTests();
const r4 = dc.maybeAppendDeviceContext('list_directory', { path: H }, ok('[DIR] code'), {});
check('new chat, exploring first: note after the listing', r4.content.length === 2 && r4.content[0].text === '[DIR] code' && r4.content[1].text.startsWith('💡 Recent work'), r4.content);
const r5 = dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
check('then get_config: no duplicate (in any block)', r5.content.length === 1 && notesIn(r5) === 0, r5.content);
nudge._resetEpisodesForTests();
check('get_config error: untouched', dc.maybeAppendDeviceContext('get_config', {}, { ...ok('boom'), isError: true }, {}).content.length === 1);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'off'; nudge._resetEpisodesForTests();
check('feature off: get_config untouched', dc.maybeAppendDeviceContext('get_config', {}, cfg, {}) === cfg);

// real get_config shape: text + structuredContent (config widget). Summary as its own block, structuredContent untouched
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'nudge'; nudge._resetEpisodesForTests();
const sc = { config: { blockedCommands: [] }, entries: [] };
const real = { content: [{ type: 'text', text: 'Current configuration:\n{}' }], structuredContent: sc };
const r6 = dc.maybeAppendDeviceContext('get_config', {}, real, {});
check('real get_config shape: summary added as a 2nd block', r6.content.length === 2 && r6.content[1].text.startsWith('💡 Recent work') && r6.structuredContent === sc, r6);
check('real get_config: config text unchanged', r6.content[0].text === 'Current configuration:\n{}');
nudge._resetEpisodesForTests();
check('get_config error text (no isError): untouched', dc.maybeAppendDeviceContext('get_config', {}, ok('Error getting configuration: boom'), {}).content.length === 1);
// located chat, quiet 4 min, then get_config: no repeat
nudge._resetEpisodesForTests();
dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
const ep = nudge.episodeFor(null); ep.located = true; ep.lastCallAt -= 4 * 60_000; ep.lastShownAt -= 20 * 60_000;
check('working in a project, pause, get_config: no repeat', dc.maybeAppendDeviceContext('get_config', {}, cfg, {}).content.length === 1);
// get_config then history 2 min later in the same chat (no idle): no duplicate
nudge._resetEpisodesForTests();
dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
nudge.episodeFor(null).lastShownAt -= 2 * 60_000;
const h = dc.maybeAppendDeviceContext('get_recent_tool_calls', {}, ok('raw'), {});
check('get_config then history: no duplicate', h.content.length === 1 && notesIn(h) === 0, h.content);

section('mode and allowlist from the config');
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both';
await t.setConfig({ allowedDirectories: [], deviceContext: 'off' });
check('config "off" beats env "both" (clients keep a stale env)', dc.deviceContextMode() === 'off', dc.deviceContextMode());
await t.setConfig({ allowedDirectories: [] });
check('no config value: env decides', dc.deviceContextMode() === 'both', dc.deviceContextMode());
await t.setConfig({ allowedDirectories: [], deviceContext: 'nonsense' });
check('an invalid config value is ignored', dc.deviceContextMode() === 'both', dc.deviceContextMode());
check('allowlist: DC rules (no list = home, [] or "/" = everything, ~ expanded)', JSON.stringify(settings.allowlistFrom(undefined)) === JSON.stringify([H]) && settings.allowlistFrom([]) === null && settings.allowlistFrom(['/srv', '/']) === null && settings.allowlistFrom(['~/code'])?.[0] === H + '/code');
settings.setConfigSource(() => { throw new Error('config unreadable'); });
await settings.refreshSettings();
const failClosed = dc.handleGetDeviceContext({}, {}).content[0].text;
check('config cannot be read: no folder is shown (not "everything")', !failClosed.includes(shop), failClosed);
settings.setConfigSource(() => t.cfg); await settings.refreshSettings();

section('the readable context file (like an AGENTS.md for the device)');
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both';
const ctxText = dc.writeContextFile();
const ctxPath = path.join(t.dcDir, 'device-context.md');
const onDisk = fs.existsSync(ctxPath) ? fs.readFileSync(ctxPath, 'utf8') : '';
check('device-context.md written', onDisk.startsWith('# Device context') && onDisk === ctxText, onDisk.slice(0, 200));
check('...with the device line and the project', /\nDevice: .+ · node v\d+/.test(onDisk) && onDisk.includes(shop), onDisk);
check('...and the "observed facts, may be out of date" note', /observed facts[\s\S]*may be out of date/.test(onDisk));
check('...pointing at get_device_context when the tool exists (both)', onDisk.includes('get_device_context'), onDisk);
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'nudge';
check('...and not when it does not (nudge: the tool is not listed)', !String(dc.writeContextFile()).includes('get_device_context'));
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both';
fs.rmSync(ctxPath, { force: true });
dc.handleGetDeviceContext({}, {});
check('get_device_context refreshes the file', fs.existsSync(ctxPath));
done();
