// The foundations every other part builds on: the shell parser, verbs, failure attribution, what is recorded,
// the journal store, the allowlist on every shown path, and the machine probes' parsing.
import fs from 'fs'; import path from 'path';
import { setup, mk, ok, q, checker, projectLine } from './harness.mjs';

const t = await setup({ prefix: 'dcf-', env: { DC_DEVICE_CONTEXT_NGINX_DIRS: '' } });
const { H, dc, shell, verbs, observe, privacy, card, rank, machine, store, projects } = t;
const { check, section, done } = checker();
const BS = '\\';
const V = verbs.commandVerb;
const A = (cmd, ctx) => verbs.failureAttributable(cmd, ctx);
const argvs = (cmd) => shell.commandsOf(shell.parseCommandLine(cmd)).map((c) => c.argv);

section('shell parser');
check('separators inside quotes are not steps', JSON.stringify(argvs('node -e "/* ; npm test ; */"')) === JSON.stringify([['node', '-e', '/* ; npm test ; */']]), argvs('node -e "/* ; npm test ; */"'));
check('single quotes too', argvs("echo 'a && b' && npm test").length === 2);
check('&& || ; | and newlines split', argvs('a && b || c ; d | e\nf').map((w) => w[0]).join('') === 'abcdef', argvs('a && b || c ; d | e\nf'));
check('2>&1 and > file are redirections, not words or background jobs', JSON.stringify(argvs('npm test 2>&1 > out.log')) === JSON.stringify([['npm', 'test']]) && !shell.parseCommandLine('npm test 2>&1').items.some((i) => i.after === '&'), argvs('npm test 2>&1 > out.log'));
check('FOO=1 before a command is an assignment', JSON.stringify(argvs('FOO=1 BAR=x npm test')) === JSON.stringify([['npm', 'test']]));
check('sudo / env / timeout / nohup are peeled', JSON.stringify(argvs('sudo -u www env A=1 timeout 30 nohup systemctl restart shop')) === JSON.stringify([['systemctl', 'restart', 'shop']]), argvs('sudo -u www env A=1 timeout 30 nohup systemctl restart shop'));
check('bash -lc "…" is read inside', JSON.stringify(argvs('bash -lc "cd /x && npm test"')) === JSON.stringify([['cd', '/x'], ['npm', 'test']]), argvs('bash -lc "cd /x && npm test"'));
check('cmd /c "… & …" is read inside (& runs the next command)', JSON.stringify(argvs(`cmd /c "cd C:${BS}x & npm test"`)) === JSON.stringify([['cd', `C:${BS}x`], ['npm', 'test']]), argvs(`cmd /c "cd C:${BS}x & npm test"`));
check('powershell -NoProfile -ExecutionPolicy Bypass -Command "…"', JSON.stringify(argvs(`powershell -NoProfile -ExecutionPolicy Bypass -Command "cd C:${BS}x; npm test"`)) === JSON.stringify([['cd', `C:${BS}x`], ['npm', 'test']]));
check('PowerShell call operator & "C:\\…\\node.exe" is not a background job', JSON.stringify(argvs(`& "C:${BS}Program Files${BS}nodejs${BS}node.exe" app.js`)) === JSON.stringify([[`C:${BS}Program Files${BS}nodejs${BS}node.exe`, 'app.js']]));
check('Windows paths keep their backslashes', argvs(`cd C:${BS}Users${BS}me${BS}shop`)[0][1] === `C:${BS}Users${BS}me${BS}shop`);
check('$(…), backticks, subshells, heredocs, control flow mark the line complex', ['cd $(mktemp -d) && npm test', 'echo `date`', '(cd /x && npm test)', 'cat <<EOF\nx\nEOF', 'for f in *; do npm test; done', 'powershell -EncodedCommand AAAA'].every((c) => shell.parseCommandLine(c).complex));
check('comments are not commands', JSON.stringify(argvs('npm test # && rm -rf /')) === JSON.stringify([['npm', 'test']]));

section('verbs: a closed vocabulary');
check('git global options skipped', V('git --no-pager log --oneline -5') === 'git log' && V('git -C /p --no-pager diff') === 'git diff');
check('a git alias is not recorded', V('git deploy-to-customer-acme') === 'git');
check('custom script names are not recorded', V('npm run migrate-customers') === 'npm run' && V('yarn seed-prod-db') === 'yarn run' && V('pnpm run nightly-export') === 'pnpm run', [V('npm run migrate-customers'), V('yarn seed-prod-db'), V('pnpm run nightly-export')]);
check('common scripts and builtins are', V('npm run build') === 'npm build' && V('npm test') === 'npm test' && V('npm install') === 'npm install' && V('yarn --cwd /p build') === 'yarn build' && V('pnpm -C /p run build') === 'pnpm build' && V('npm --prefix /p test') === 'npm test');
check('docker / compose options skipped, container names never kept', V('docker compose -f x.yml ps') === 'docker compose ps' && V('docker-compose logs web') === 'docker compose logs' && V('docker --context x compose up -d') === 'docker compose up' && V('docker -H x ps') === 'docker ps' && V('docker acme-payroll') === 'docker');
check('systemctl / service', V('systemctl --user status shop') === 'systemctl status' && V('service nginx restart') === 'service restart');
check('the real step wins over a trailing look', V('npm run build && git status') === 'npm build');
check('look verbs are looks', ['git log', 'git status', 'npm outdated', 'docker compose ps', 'systemctl status'].every((v) => verbs.isLookVerb(v)) && !verbs.isLookVerb('npm test') && !verbs.isLookVerb('node'));
check('npx <known tool>', V('npx tsc -p .') === 'tsc' && V('npx some-unknown-pkg') === null);

section('failure attribution follows the exit code');
check('cd /p && npm test: npm test\'s', A('cd /x && node resize.js') && A('cd /p && npm test') && A('export X=1 && node a.js') && A('FOO=1 npm test'));
check('npm install && npm test: could be either', !A('npm install && npm test'));
check('npm install ; npm test: npm test\'s (; keeps the last exit code)', A('npm install ; npm test'));
check('npm test && echo done: npm test\'s (echo cannot fail)', A('npm test && echo done'));
check('npm test | grep FAIL: grep\'s', !A('npm test 2>&1 | grep FAIL'));
check('|| and background jobs: never', !A('npm test || true') && !A('npm test &') && !A('npm test || echo failed'));
check('look commands and unknown tools: never', !A('git status') && !A('systemctl restart shop && curl localhost'));
check('complex lines: never', !A('cd $(mktemp -d) && npm test') && !A('for f in a b; do npm test; done'));
check('wrapped: bash -lc "cd /p && npm test"', A('bash -lc "cd /p && npm test"') && !A('bash -lc "npm test &"'));
const real = mk(path.join(H, 'code', 'real'), { 'package.json': '{"name":"real"}' });
const exists = (p) => fs.existsSync(p);
check('a cd into a missing folder: the test never ran', !A(`cd ${q(path.join(H, 'missing'))} && npm test`, { exists }) && !A(`cd ${q(path.join(H, 'missing'))} ; npm test`, { exists }));
check('a cd into an existing folder: the failure is the test\'s', A(`cd ${q(real)} && npm test`, { exists }));
check('a relative cd that the output says failed', !A('cd backend && npm test', { output: 'bash: cd: backend: No such file or directory' }) && !A('cd backend; npm test', { output: "Set-Location : Cannot find path 'C:\\x\\backend' because it does not exist." }));

section('what is recorded');
const shop = mk(path.join(H, 'code', 'shop'), { '.git/HEAD': 'ref: refs/heads/main\n', 'package.json': '{}', '.env.production': 'X=1' });
const obs = (tool, args) => observe.observeEvent({ t: new Date().toISOString(), tool, args }, { home: H });
let r = obs('start_process', { command: `docker run --rm -v ${q(shop + ':/app')} -w /app node:20 npm test` });
check('docker -v: the host folder only, never the container\'s /app', r.journal.length === 1 && projects.sameProject(r.journal[0].root, shop), r);
r = obs('start_process', { command: `cd ${q(shop)}\nnpm test` });
check('newline-separated script keeps its verb', r.journal.some((j) => j.verb === 'npm test'), r);
r = obs('read_file', { path: path.join(shop, '.env.production') });
check('.env files are recorded by name only (by design), never contents', r.journal.length === 1 && r.journal[0].file === '.env.production', r);
r = obs('read_file', { path: path.join(H, '.ssh', 'id_ed25519') });
check('credential folders are not recorded', !r.journal.length && r.dropped.some((d) => /sensitive path/.test(d.reason)), r);
r = obs('start_process', { command: `cd ${q(shop)} && npm test -- --token=abcdef123456789` });
check('a command with a secret is dropped whole', !r.journal.length && r.dropped.some((d) => /secret/.test(d.reason)), r);
const leaky = mk(path.join(H, 'code', 'leaky'), { 'package.json': '{"name":"leaky","description":"deploy helper token=fixturevalue123"}' });
const d = machine.describeProject(leaky) ?? '';
check('a credential in a package.json description is redacted', !d.includes('fixturevalue123') && d.includes('[REDACTED]'), d);
const plain = mk(path.join(H, 'code', 'plain'), { 'package.json': '{"name":"plain","description":"Online store for handmade ceramics"}' });
check('an ordinary description is unchanged', machine.describeProject(plain) === 'plain: Online store for handmade ceramics', machine.describeProject(plain));

section('the journal store');
const f = path.join(H, 'j.jsonl');
const row = (root, days = 0, extra = {}) => ({ t: new Date(Date.now() - days * 86400e3).toISOString(), origin: 'local', root, kind: 'edit', ...extra });
fs.writeFileSync(f, [row(shop, 1), row(shop, 89.99)].map((x) => JSON.stringify(x)).join('\n') + '\n');
const j = new store.Journal({ file: () => f, retentionMs: 90 * 86400e3, maxReadBytes: 1 << 20, compactAtBytes: 1 << 30 });
check('reads the rows', j.all(Date.now()).length === 2);
check('a row expires on a later read although the file did not change', j.all(Date.now() + 3600e3).length === 1);
fs.appendFileSync(f, JSON.stringify(row(real)) + '\n');
check('rows another process appended are read (only the new bytes)', j.all(Date.now()).some((x) => x.root === real));
fs.appendFileSync(f, JSON.stringify(row(real)).slice(0, 20));
check('a line still being written is not read yet', j.all(Date.now()).length === 3);
fs.appendFileSync(f, JSON.stringify(row(real)).slice(20) + '\n');
check('...and is once it is complete', j.all(Date.now()).length === 4);
fs.writeFileSync(f, JSON.stringify(row(shop)) + '\n' + JSON.stringify({ t: 'x', root: 123, kind: 'edit' }) + '\n');
check('a replaced file is read again; invalid rows are skipped', j.all(Date.now()).length === 1);
j.truncate();
check('forget: empty', j.all(Date.now()).length === 0 && fs.existsSync(f));
fs.writeFileSync(f, '{"a":1}\n{"b":22222}\n{"c":3}\n');
check('readTail starts at a whole line', store.readTail(f, 12) === '{"c":3}\n' && store.readTail(f, 1000) === '{"a":1}\n{"b":22222}\n{"c":3}\n');

section('every shown path is checked against the allowlist');
const work = mk(path.join(H, 'work', 'shop'), { '.git/HEAD': 'ref: refs/heads/main\n', 'service/server.js': '' });
const service = path.join(work, 'service');
const c1 = card.renderCard([], [], { now: new Date(), home: H, allowed: [service], running: [{ kind: 'docker', label: 'docker shop-api', dir: service }], attribution: 'none' });
check('a running folder inside the allowlist whose git root is outside: the folder is shown, not the root', !!c1 && c1.includes(service) && !new RegExp(`in \`${work.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\``).test(c1), c1);
const c2 = card.renderCard([], [], { now: new Date(), home: H, allowed: [shop], running: [{ kind: 'nginx', label: 'nginx secret-client.example.com' }, { kind: 'docker', label: 'docker acme-payroll-db' }] });
check('running entries without a folder are not shown under an allowlist', !c2 || (!c2.includes('secret-client') && !c2.includes('payroll')), c2);

section('is it running: say only what is known');
const app = mk(path.join(H, 'code', 'app'), { 'package.json': '{"name":"app","scripts":{"start":"node server.js"}}', 'server.js': '' });
const rowsApp = [row(app, 0.1, { kind: 'edit', file: 'server.js' })];
const line = (attribution) => projectLine(card.renderCard(rowsApp, rank.rank(rowsApp, new Date()), { now: new Date(), home: H, running: [], attribution }), app);
check('every listening port has a visible owner: "NOT running now"', line('complete').includes('NOT running now'), line('complete'));
check('some ports have no visible owner: no "NOT running" claim', !line('partial').includes('NOT running') && line('partial').includes('no listening port traced'), line('partial'));
check('no port could be traced: nothing said', !/running|listening/i.test(line('none')), line('none'));

section('nginx');
check('commented-out directives are ignored', !/proxy_pass/.test(machine.stripNginxComments('server {\n  # proxy_pass http://127.0.0.1:1;\n}')) && machine.stripNginxComments('add_header X "a#b"; # c').includes('"a#b"'));

section('the note: a missing path from a shell command');
const n1 = t.nudge.classify('start_process', { command: `ls ${q(path.join(H, 'projects', 'shop'))}` }, ok(`ls: cannot access '${path.join(H, 'projects', 'shop')}': No such file or directory`));
check('ls of a missing guessed path = not found, with the path\'s words as terms', n1.notFound && n1.kind === 'partial' && n1.terms.includes('shop'), n1);
const n2 = t.nudge.classify('start_process', { command: `node ${q(path.join(shop, 'server.js'))}` }, ok('Error: Cannot find module x\nnot found'));
check('a program printing "not found" is not a guessed path', !n2.notFound, n2);
const n3 = t.nudge.classify('start_process', { command: `fd -e js shop ${q(H)}` }, ok(''));
check('fd: the pattern after value options is the search term', n3.kind === 'partial' && n3.terms.includes('shop'), n3);
done();
