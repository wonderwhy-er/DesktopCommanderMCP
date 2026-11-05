/**
 * The two test lists, test/timed.txt and test/excluded.txt, read by one helper
 * (readTestList in helpers/node-test-runner.js): one test per line,
 * "<name>  # <reason>", the name relative to test/. A line without a reason, or
 * naming a file that isn't there, stops the run with the list and the line.
 * withoutExcluded leaves the excluded tests out of a runner's files; the README
 * says how many there are.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { byTimed, excludedNames, findTests, readRunnerArgs, readTestList, ROOT, timedNames, withoutExcluded } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir, withEnv } from './helpers/test-env.js';

// Every folder this file makes, under one removed at the end
let base;
let made = 0;

/** A test/ folder of its own: the lists given, and empty files for the tests they name */
function testFolder(lists, files) {
  const dir = path.join(base, String(made++), 'test');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '');
  }
  for (const [list, text] of Object.entries(lists)) fs.writeFileSync(path.join(dir, `${list}.txt`), text);
  return dir;
}

function reading() {
  const dir = testFolder({
    excluded: [
      '# A comment, and a blank line, are no entries',
      '',
      'test-a.js  # needs a service CI doesn\'t have',
      '   # an indented comment',
      'repro/test-b.js#no space before it',
      'integration/c.js  #  spaces around the reason  ',
    ].join('\r\n'),
  }, ['test-a.js', 'repro/test-b.js', 'integration/c.js']);
  assert.deepStrictEqual(readTestList('excluded', { dir }), [
    { name: 'test-a.js', reason: 'needs a service CI doesn\'t have' },
    { name: 'repro/test-b.js', reason: 'no space before it' },
    { name: 'integration/c.js', reason: 'spaces around the reason' },
  ]);
  console.log('✓ readTestList: one test per line, its reason after #; comments and blank lines skipped');

  const noReason = testFolder({ timed: '# header\ntest-a.js  # fine\ntest-b.js\n' }, ['test-a.js', 'test-b.js']);
  assert.throws(() => readTestList('timed', { dir: noReason }), (error) => /timed\.txt:3/.test(error.message) && /test-b\.js/.test(error.message) && /reason/.test(error.message),
    'a test without a reason stops the run, with the list and the line');
  const emptyReason = testFolder({ timed: 'test-a.js  #   \n' }, ['test-a.js']);
  assert.throws(() => readTestList('timed', { dir: emptyReason }), /timed\.txt:1.*reason/, 'an empty reason is no reason');
  const gone = testFolder({ excluded: 'test-a.js  # here\nrepro/test-gone.js  # renamed since\n' }, ['test-a.js']);
  assert.throws(() => readTestList('excluded', { dir: gone }), (error) => /excluded\.txt:2/.test(error.message) && /repro\/test-gone\.js/.test(error.message),
    'a test that isn\'t there stops the run: a renamed or deleted file leaves no stale line');
  console.log('✓ a line without a reason, or naming a file that isn\'t there, stops the run with the list and the line');

  // Only a file a runner finds by name can be listed: any other line would be read and then do nothing
  const found = ['test-a.js', 'b.test.js', 'repro/test-c.js', 'integration/d.js', 'docker/test-e.js'];
  const notFound = ['x.test.ps1', 'helper.js', 'helpers/test-f.js', 'repro/helper.js', 'docker/g.js', 'fixtures/test-h.js'];
  const lists = testFolder({ excluded: found.map((name) => `${name}  # found by name`).join('\n') }, [...found, ...notFound]);
  assert.deepStrictEqual(readTestList('excluded', { dir: lists }).map(({ name }) => name), found, 'each runner\'s own files can be listed');
  for (const name of notFound) {
    fs.writeFileSync(path.join(lists, 'timed.txt'), `test-a.js  # fine\n${name}  # not a runner's\n`);
    assert.throws(() => readTestList('timed', { dir: lists }), (error) => /timed\.txt:2/.test(error.message) && error.message.includes(name) && /runner/.test(error.message),
      `${name}: no runner finds it, so listing it stops the run`);
  }
  fs.writeFileSync(path.join(lists, 'timed.txt'), 'x.test.ps1  # one of the PowerShell tests\n');
  assert.throws(() => readTestList('timed', { dir: lists }), /test-powershell-tests\.js/, 'a PowerShell test: the message names the test that runs them');
  console.log('✓ a line naming a file no runner finds by name (a .ps1 test, a helper, a fixture) stops the run');
}

async function theRepoLists() {
  // Every entry has its reason and its file, or reading them throws
  const timed = readTestList('timed');
  assert.ok(timed.length > 0 && timed.every(({ name, reason }) => name && reason), 'test/timed.txt: each timed test with its reason');
  assert.deepStrictEqual(timedNames(), timed.map(({ name }) => name), 'timedNames: the names in test/timed.txt');
  assert.deepStrictEqual(excludedNames(), readTestList('excluded').map(({ name }) => name), 'excludedNames: the names in test/excluded.txt');
  const options = readRunnerArgs(['--without-timed'], path.join(ROOT, 'test-results'));
  assert.ok(!byTimed(timedNames().filter((name) => !name.includes('/')), options, '').length, 'byTimed reads the same list');

  // The README says how many are excluded, and points to the file
  const readme = fs.readFileSync(path.join(ROOT, 'test', 'README.md'), 'utf8');
  const count = excludedNames().length;
  const says = count === 0 ? 'lists no test now' : `lists ${count} test${count === 1 ? '' : 's'}`;
  assert.ok(readme.includes(`\`test/excluded.txt\` ${says}`), `the README says test/excluded.txt ${says}`);
  console.log('✓ the repo\'s lists read, each test with its reason; the README gives the excluded count');

  // withoutExcluded: a runner's files less the excluded ones in its folder, by the lists DC_TEST_LISTS_DIR points to
  const lists = path.join(base, 'moved-lists');
  fs.mkdirSync(lists);
  fs.copyFileSync(path.join(ROOT, 'test', 'timed.txt'), path.join(lists, 'timed.txt'));
  fs.writeFileSync(path.join(lists, 'excluded.txt'), 'test-coverage-areas.js  # a stand-in reason\nrepro/test-dc-tracking-gate.js  # another\n');
  await withEnv({ DC_TEST_LISTS_DIR: lists }, async () => {
    assert.deepStrictEqual(excludedNames(), ['test-coverage-areas.js', 'repro/test-dc-tracking-gate.js'], 'DC_TEST_LISTS_DIR moves the lists, the names still in test/');
    assert.deepStrictEqual(withoutExcluded(['test-coverage-areas.js', 'test-dc-tracking-gate.js', 'test-x.js'], ''), ['test-dc-tracking-gate.js', 'test-x.js'],
      'the suite leaves out its own excluded file, not repro/\'s of the same name');
    assert.deepStrictEqual(withoutExcluded(['test-coverage-areas.js', 'test-dc-tracking-gate.js'], 'repro'), ['test-coverage-areas.js'], 'repro/ leaves out its own');
  });
  console.log('✓ withoutExcluded: each runner leaves out its own folder\'s excluded tests');
}

/** Fail closed: a runner given no names that finds no test file in its folder fails, rather than passing with none */
function findingNothing() {
  const suite = testFolder({}, ['test-a.js', 'b.test.js', 'helper.js']);
  assert.deepStrictEqual(findTests('', suite), ['b.test.js', 'test-a.js'], 'the suite\'s rule, sorted');
  const empty = testFolder({}, ['helper.js', 'notes.md']);
  assert.throws(() => findTests('', empty), (error) => /No test file found/.test(error.message) && error.message.includes(empty), 'none found: an error naming the folder');
  const repro = path.join(testFolder({}, ['repro/helper.js']), 'repro');
  assert.throws(() => findTests('repro', repro), /No test file found/, 'repro/ with only a helper');
  console.log('✓ a runner that finds no test file in its folder fails');
}

export default async function run() {
  base = createTempDir('dc-test-lists-');
  try {
    reading();
    await theRepoLists();
    findingNothing();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
