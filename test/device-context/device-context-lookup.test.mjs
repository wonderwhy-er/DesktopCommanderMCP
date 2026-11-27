// get_device_context({ project }): an exact path is that project; a path inside one is that one; an existing folder
// with no activity is itself (never a same-named checkout elsewhere); a bare name falls back to name matching.
// One folder spelled with other capitals is one project where the file system ignores case.
import fs from 'fs'; import path from 'path';
import { setup, mk, ok, checker } from './harness.mjs';

const t = await setup({ prefix: 'dcl-' });
const { H, dc } = t;
const { check, section, done } = checker();
const oldShop = mk(path.join(H, 'Projects', 'Old', 'shop'), { 'package.json': '{"name":"shop","description":"Old shop"}', 'server.js': 'x' });
const newShop = mk(path.join(H, 'Projects', 'New', 'shop'), { 'package.json': '{"name":"shop","description":"New shop"}', 'server.js': 'x', 'src/a.js': '' });
const archive = mk(path.join(H, 'archive', 'shop'), { 'package.json': '{"name":"shop"}', 'server.js': 'x' });
// the old shop is busier, so a name match would pick it first
for (let i = 0; i < 4; i++) dc.observeToolCall('edit_block', { file_path: path.join(oldShop, 'server.js'), old_string: 'a', new_string: 'b' }, ok('done'), false);
dc.observeToolCall('read_file', { path: path.join(newShop, 'server.js') }, ok('x'), false);
const ask = (project) => dc.handleGetDeviceContext({ project }, {}).content[0].text;

section('exact paths');
let r = ask(newShop);
check('exact path with capitals -> that project', r.includes(newShop) && !r.includes(oldShop), r);
r = ask(oldShop);
check('the other exact path -> the other project', r.includes(oldShop) && !r.includes(newShop), r);
r = ask(path.join(newShop, 'src'));
check('a folder inside a known project -> that project', r.includes(newShop) && !r.includes(oldShop), r);
r = ask(archive);
check('an existing folder without activity -> itself, not a same-named checkout', !r.includes(oldShop) && !r.includes(newShop) && r.includes('No recorded activity'), r);
r = ask('shop');
check('a bare name still finds a shop', r.includes(oldShop) || r.includes(newShop), r);
r = ask(path.join(H, 'projects', 'gone', 'shop'));
check('a path that does not exist falls back to the name', r.includes(oldShop) || r.includes(newShop), r);

section('one folder, two spellings');
const caseInsensitive = fs.existsSync(newShop.toUpperCase()) || fs.existsSync(newShop.toLowerCase());
if (!caseInsensitive) console.log('       (skipped: this file system is case-sensitive, so two spellings are two folders)');
else {
  const variant = newShop.replace(`${path.sep}Projects${path.sep}New${path.sep}`, `${path.sep}projects${path.sep}new${path.sep}`);
  dc.observeToolCall('edit_block', { file_path: path.join(variant, 'server.js'), old_string: 'a', new_string: 'b' }, ok('done'), false);
  const rows = t.journal().filter((x) => x.root.toLowerCase() === newShop.toLowerCase());
  check('recorded under the folder\'s own spelling', rows.length >= 2 && rows.every((x) => x.root === rows[0].root), rows);
  const card = dc.handleGetDeviceContext({ limit: 10 }, {}).content[0].text;
  const listed = card.split('\n').filter((l) => /^\d+\. /.test(l) && l.toLowerCase().includes(newShop.toLowerCase() + '`'));
  check('...and listed once on the card', listed.length === 1, card);
  t.writeJournal([...t.journal(), { t: new Date().toISOString(), origin: 'local', root: variant, kind: 'edit', file: 'server.js' }]);
  const card2 = dc.handleGetDeviceContext({ limit: 10 }, {}).content[0].text;
  check('an old row in another spelling joins the same project', card2.split('\n').filter((l) => /^\d+\. /.test(l) && l.toLowerCase().includes(newShop.toLowerCase() + '`')).length === 1, card2);
}
fs.rmSync(H, { recursive: true, force: true });
done();
