import fs from 'fs'; import os from 'os'; import path from 'path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc6-'));
Object.assign(process.env, { DC_DEVICE_CONTEXT_HOME: home, DESKTOP_COMMANDER_DEVICE_CONTEXT: 'nudge', DC_DEVICE_CONTEXT_NO_RUNNING: '1' });
const shop = path.join(home, 'code', 'shop'); fs.mkdirSync(shop, { recursive: true }); fs.writeFileSync(path.join(shop, 'package.json'), '{"name":"shop"}');
fs.mkdirSync(path.join(home, '.claude-server-commander'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude-server-commander', 'device-context-events.jsonl'), JSON.stringify({ t: new Date(Date.now() - 86400e3).toISOString(), origin: 'local', root: shop, kind: 'edit', file: '.env' }) + '\n');
const dc = await import('../../dist/device-context/index.js');
const nudge = await import('../../dist/device-context/nudge.js');
let fails = 0; const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : '  ' + String(info).slice(0, 300)}`); if (!ok) fails++; };
const res = (t) => ({ content: [{ type: 'text', text: t }] });
const cfg = res('{ "blockedCommands": [] }');
const r1 = dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
check('get_config: own output first, then the note', r1.content[0].text === '{ "blockedCommands": [] }' && r1.content[1].text.startsWith('💡 Recent work on this device') && r1.content[1].text.includes(shop), JSON.stringify(r1.content).slice(0, 300));
check('original result untouched', cfg.content[0].text === '{ "blockedCommands": [] }');
const r2 = dc.maybeAppendDeviceContext('list_directory', { path: home }, res('[DIR] code'), {});
check('exploring right after get_config: no second note', !r2.content[0].text.includes('💡'), r2.content[0].text);
const r3 = dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
check('second get_config in the same chat: no note', !r3.content[0].text.includes('💡'), r3.content[0].text);
nudge._resetEpisodesForTests();
const r4 = dc.maybeAppendDeviceContext('list_directory', { path: home }, res('[DIR] code'), {});
check('new chat, exploring first: note after the listing', r4.content[0].text === '[DIR] code' && r4.content[1].text.startsWith('💡 Recent work'), JSON.stringify(r4.content).slice(0, 300));
const r5 = dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
check('then get_config: no duplicate', !r5.content[0].text.includes('💡'), r5.content[0].text);
nudge._resetEpisodesForTests();
check('get_config error: untouched', dc.maybeAppendDeviceContext('get_config', {}, { ...res('boom'), isError: true }, {}).content[0].text === 'boom');
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'off'; nudge._resetEpisodesForTests();
check('feature off: get_config untouched', dc.maybeAppendDeviceContext('get_config', {}, cfg, {}) === cfg);

// real get_config shape: text + structuredContent (config widget). Summary as its own block, structuredContent untouched
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'nudge'; nudge._resetEpisodesForTests();
const sc = { config: { blockedCommands: [] }, entries: [] };
const real = { content: [{ type: 'text', text: 'Current configuration:\n{}' }], structuredContent: sc };
const r6 = dc.maybeAppendDeviceContext('get_config', {}, real, {});
check('real get_config shape: summary added as a 2nd block', r6.content.length === 2 && r6.content[1].text.startsWith('💡 Recent work') && r6.structuredContent === sc, JSON.stringify(r6).slice(0, 300));
check('real get_config: config text unchanged', r6.content[0].text === 'Current configuration:\n{}');
nudge._resetEpisodesForTests();
check('get_config error text (no isError): untouched', dc.maybeAppendDeviceContext('get_config', {}, res('Error getting configuration: boom'), {}).content.length === 1);
// located chat, quiet 4 min, then get_config: no repeat
nudge._resetEpisodesForTests();
dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
const ep = nudge.episodeFor(null); ep.located = true; ep.lastCallAt -= 4 * 60_000; ep.lastShownAt -= 20 * 60_000;
check('working in a project, pause, get_config: no repeat', dc.maybeAppendDeviceContext('get_config', {}, cfg, {}).content.length === 1);
// get_config then history 2 min later in the same chat (no idle): no duplicate
nudge._resetEpisodesForTests();
dc.maybeAppendDeviceContext('get_config', {}, cfg, {});
nudge.episodeFor(null).lastShownAt -= 2 * 60_000;
const h = dc.maybeAppendDeviceContext('get_recent_tool_calls', {}, res('raw'), {});
check('get_config then history: no duplicate', !h.content.some((c) => c.text.includes('💡')), JSON.stringify(h.content).slice(0, 200));

// mode file wins over the env var (Claude Desktop keeps a stale env)
fs.writeFileSync(path.join(home, '.claude-server-commander', 'device-context-mode'), 'off\n');
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both'; dc._resetModeForTests();
check('mode file "off" beats env "both"', dc.deviceContextMode() === 'off', dc.deviceContextMode());
fs.unlinkSync(path.join(home, '.claude-server-commander', 'device-context-mode')); dc._resetModeForTests();
check('no mode file: env decides', dc.deviceContextMode() === 'both', dc.deviceContextMode());

// the readable context file (like an AGENTS.md for the device)
process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both'; dc._resetModeForTests();
const ctxText = dc.writeContextFile();
const ctxPath = path.join(home, '.claude-server-commander', 'device-context.md');
const onDisk = fs.existsSync(ctxPath) ? fs.readFileSync(ctxPath, 'utf8') : '';
check('device-context.md written', onDisk.startsWith('# Device context') && onDisk === ctxText, onDisk.slice(0, 200));
check('...with the device line and the project', /\nDevice: .+ · node v\d+/.test(onDisk) && onDisk.includes(shop), onDisk);
check('...and the "observed facts, may be out of date" note', /observed facts[\s\S]*may be out of date/.test(onDisk));
fs.rmSync(ctxPath, { force: true });
dc.handleGetDeviceContext({}, {});
check('get_device_context refreshes the file', fs.existsSync(ctxPath));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
