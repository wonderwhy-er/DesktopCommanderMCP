// Dev scripts: the device-context mode in Desktop Commander's real config (~/.claude-server-commander/config.json).
// The mode lives there and wins over DESKTOP_COMMANDER_DEVICE_CONTEXT, so a script that sets the mode through the
// env (an eval arm, an "earlier chat") must first make sure the config does not override it.
//   node dev-config.mjs get              print the mode in config.json ('' when not set)
//   node dev-config.mjs set <mode>       off | tool | nudge | both
//   node dev-config.mjs unset            remove it: the env var decides (back up config.json first)
//   node dev-config.mjs require <mode>   exit 1, saying why, when config.json would override <mode>
import fs from 'fs'; import os from 'os'; import path from 'path'; import { pathToFileURL } from 'url';

/** DC's config is always in the real home folder (DC_DEVICE_CONTEXT_HOME moves only device context's own files). */
export const configFile = path.join(os.homedir(), '.claude-server-commander', 'config.json');
const MODES = ['off', 'tool', 'nudge', 'both'];
const norm = (v) => { const s = String(v ?? '').trim().toLowerCase(); return ['1', 'true', 'on'].includes(s) ? 'both' : ['0', 'false'].includes(s) ? 'off' : s; };

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`${configFile} is not valid JSON (${e.message}); fix it before running this script`); }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const tmp = `${configFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, configFile);
}
export const configMode = () => (readConfig().deviceContext == null ? '' : norm(readConfig().deviceContext));
/** null when DC would run in `want` mode with the env var set to it; otherwise the reason it would not. */
export function modeConflict(want) {
  const m = configMode();
  return m && m !== want ? `${configFile} sets "deviceContext": "${m}", which overrides DESKTOP_COMMANDER_DEVICE_CONTEXT=${want}. Remove it (node test/device-context/dev-config.mjs unset, after backing the file up) and rerun.` : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'get') console.log(configMode());
    else if (cmd === 'set' && MODES.includes(norm(arg))) { writeConfig({ ...readConfig(), deviceContext: norm(arg) }); console.log(`deviceContext = ${norm(arg)} in ${configFile}`); }
    else if (cmd === 'unset') { const c = readConfig(); if ('deviceContext' in c) { delete c.deviceContext; writeConfig(c); } console.log(`deviceContext not set in ${configFile}`); }
    else if (cmd === 'require' && MODES.includes(norm(arg))) { const why = modeConflict(norm(arg)); if (why) { console.error(why); process.exit(1); } }
    else { console.error('usage: dev-config.mjs get | set <off|tool|nudge|both> | unset | require <mode>'); process.exit(2); }
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
