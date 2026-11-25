// get_device_context(project=<exact path>) must return that project, even with capital letters in the path
// and another project with the same folder name (review finding: macOS/Linux paths with capitals fell back to name matching).
import fs from 'fs'; import os from 'os'; import path from 'path'; import { pathToFileURL } from 'url';
const DIST = process.argv[2] || './dist';
const H = fs.mkdtempSync(path.join(os.tmpdir(), 'dcl-'));
process.env.DC_DEVICE_CONTEXT_HOME = H; process.env.DESKTOP_COMMANDER_DEVICE_CONTEXT = 'both'; process.env.DC_DEVICE_CONTEXT_NO_RUNNING = '1';
const mk = (p, files) => { fs.mkdirSync(p, { recursive: true }); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(p, f), c); };
const oldShop = path.join(H, 'Projects', 'Old', 'shop'), newShop = path.join(H, 'Projects', 'New', 'shop');
mk(oldShop, { 'package.json': '{"name":"shop","description":"Old shop"}', 'server.js': 'x' });
mk(newShop, { 'package.json': '{"name":"shop","description":"New shop"}', 'server.js': 'x' });
const dc = await import(pathToFileURL(path.resolve(DIST, 'device-context/index.js')).href);
const ok = (t) => ({ content: [{ type: 'text', text: t }] });
// the old shop is busier, so a name match would pick it first
for (let i = 0; i < 4; i++) dc.observeToolCall('edit_block', { file_path: path.join(oldShop, 'server.js'), old_string: 'a', new_string: 'b' }, ok('done'), false);
dc.observeToolCall('read_file', { path: path.join(newShop, 'server.js') }, ok('x'), false);
await new Promise((r) => setTimeout(r, 300));
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) { failed++; if (detail) console.log('       ' + detail.slice(0, 400).replace(/\n/g, '\n       ')); } };
const t1 = dc.handleGetDeviceContext({ project: newShop }, {}).content[0].text;
check('exact path with capitals -> that project', t1.includes(newShop) && !t1.includes(oldShop), t1);
const t2 = dc.handleGetDeviceContext({ project: oldShop }, {}).content[0].text;
check('the other exact path -> the other project', t2.includes(oldShop) && !t2.includes(newShop), t2);
const t3 = dc.handleGetDeviceContext({ project: 'shop' }, {}).content[0].text;
check('bare name still finds a shop', t3.includes(oldShop) || t3.includes(newShop), t3);
fs.rmSync(H, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
