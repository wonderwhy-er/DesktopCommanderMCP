/**
 * Starting the server must not load the packages only Excel, PDF and DOCX
 * files need before it answers `initialize` (#715). Every launch loaded them
 * first, whether or not the session ever opened such a file: 1,183 of the
 * 1,556 modules loaded before the answer, which one reporter saw take 25-90 s
 * and time the client out. Nor may a tool call wait for one to load: a client
 * gives a call a few seconds (review on #777). So right after `initialize` the
 * server loads them in the background, one at a time; a call that needs one
 * still loading answers at once that it is still loading, and works once it
 * is loaded. A load that fails is not kept: the call says so, and a later call
 * loads it again.
 *
 * Starts the real server (dist/index.js) over MCP stdio, the way a client
 * does, recording every module it resolves (import and require).
 */
import assert from 'assert';
import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { HEAVY_PACKAGES, packageOf, startServerRecordingModules } from './helpers/server-modules.js';
import { callToolOnceLoaded } from './helpers/heavy-packages.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_PDF = path.join(PROJECT_ROOT, 'test/samples/01_sample_simple.pdf');
/** The background load takes a few seconds at most; far above that */
const LOAD_DEADLINE_MS = 30_000;
/** An answer "at once": a refused call takes milliseconds; far above that */
const AT_ONCE_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heavyLoaded = (modules) => HEAVY_PACKAGES.filter((pkg) => modules.some((module) => packageOf(module.url) === pkg));

function text(result) {
  return (result.content ?? []).map((item) => item.text ?? '').join('\n');
}

async function callTool(client, name, args) {
  const result = await callToolOnceLoaded(client, { name, arguments: args });
  assert.notStrictEqual(result.isError, true, `${name} ${JSON.stringify(args)} failed: ${text(result)}`);
  return text(result);
}

/** Nothing for Excel, PDF or DOCX is loaded before the server answers `initialize` */
async function testNothingLoadedBeforeInitialize(server) {
  // Before the answer arrived: the server starts its background load only after it
  const beforeAnswer = server.modules().filter((module) => module.at < server.initializedAt && !module.url.startsWith('node:'));
  const loaded = heavyLoaded(beforeAnswer);
  assert.deepStrictEqual(loaded, [],
    `the server loaded ${loaded.join(', ')} before answering initialize ` +
    `(${beforeAnswer.length} modules resolved before the answer)`);
  console.log(`✓ Nothing for Excel, PDF or DOCX loaded before initialize was answered (${beforeAnswer.length} modules)`);
}

/** Shortly after it, all of them are loaded, without any tool call */
async function testLoadedSoonAfterInitialize(server) {
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  let missing = HEAVY_PACKAGES;
  while (missing.length > 0 && Date.now() < deadline) {
    await sleep(100);
    const loaded = heavyLoaded(server.modules());
    missing = HEAVY_PACKAGES.filter((pkg) => !loaded.includes(pkg));
  }
  assert.deepStrictEqual(missing, [],
    `${LOAD_DEADLINE_MS / 1000} s after initialize, with no tool call, the server had not loaded ${missing.join(', ')}: ` +
    'the first call that needs them loads them inside the call, which a client gives only a few seconds');
  const lastAt = Math.max(...server.modules().filter((module) => HEAVY_PACKAGES.includes(packageOf(module.url))).map((module) => module.at));
  console.log(`✓ All of them loaded in the background, the last ${lastAt - server.initializedAt} ms after initialize was answered`);
}

/** Excel, DOCX and PDF files work once loaded */
async function testFilesWorkOnceLoaded(server, dir) {
  const { client } = server;
  const xlsx = path.join(dir, 'budget.xlsx');
  await callTool(client, 'write_file', { path: xlsx, content: JSON.stringify([['Item', 'Note'], ['Alice', 'ZebraQuartz budget']]) });
  assert(/ZebraQuartz budget/.test(await callTool(client, 'read_file', { path: xlsx })),
    'reading back a spreadsheet written through the server should show its cells');

  const docx = path.join(dir, 'memo.docx');
  await callTool(client, 'write_file', { path: docx, content: 'Memo title\nThe ZebraQuartz review is due' });
  await callTool(client, 'edit_block', { file_path: docx, old_string: 'ZebraQuartz', new_string: 'ZebraQuokka' });
  assert(/ZebraQuokka review/.test(await callTool(client, 'read_file', { path: docx })),
    'reading back a DOCX written and edited through the server should show the edited text');

  assert((await callTool(client, 'read_file', { path: SAMPLE_PDF })).trim().length > 0,
    'reading a PDF through the server should return its text');
  console.log('✓ Excel, DOCX and PDF files work once their support is loaded');
}

/** A call that needs a package still loading answers at once that it is still loading */
async function testCallWhileLoadingAnswersAtOnce(server, file) {
  const started = Date.now();
  const call = server.client.callTool({ name: 'read_file', arguments: { path: file } }, undefined, { timeout: 120_000 });
  const answer = await Promise.race([call, sleep(AT_ONCE_MS).then(() => null)]);
  try {
    assert(answer,
      `with PDF reading support still loading, read_file of a PDF gave no answer within ${AT_ONCE_MS / 1000} s: ` +
      'it waited for unpdf to load inside the call, and a client gives a call only a few seconds');
    assert(answer.isError === true && /Can't read held\.pdf yet: Desktop Commander is still loading its PDF reading support/.test(text(answer)),
      `with PDF reading support still loading, read_file of held.pdf should answer at once that it can't read held.pdf yet; it answered: ${text(answer)}`);
    console.log(`✓ A call while PDF reading support is loading answers in ${Date.now() - started} ms: ${text(answer)}`);
  } finally {
    server.release();
    await call.catch(() => {});
  }
}

/** read_multiple_files says so for each file that needs it, by its name */
async function testReadMultipleFilesWhileLoading(server, file, second) {
  const answer = text(await server.client.callTool({ name: 'read_multiple_files', arguments: { paths: [file, second] } }));
  for (const name of [path.basename(file), path.basename(second)]) {
    const escaped = name.replace(/\./g, '\\.');
    assert(new RegExp(`${escaped}: Error - Can't read ${escaped} yet: Desktop Commander is still loading its PDF reading support`).test(answer),
      `with PDF reading support still loading, read_multiple_files should say for ${name} that it can't read ${name} yet; it answered: ${answer}`);
  }
  console.log('✓ read_multiple_files says for each file, by name, that it can\'t be read yet');
}

/** write_pdf with markdown that starts with a link is writing a PDF, not editing one, as the tool reads it */
async function testWritePdfMarkdownStartingWithLink(server, dir) {
  // PDF writing (md-to-pdf) failed to load once; PDF editing (pdf-lib) is loaded
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  while (!server.logs().some((line) => /Loading md-to-pdf failed/.test(line)) && Date.now() < deadline) await sleep(100);
  const answer = await server.client.callTool({ name: 'write_pdf', arguments: { path: path.join(dir, 'links.pdf'), content: '[Home](https://example.com)\n\n# Links' } });
  assert(answer.isError === true && /Can't write links\.pdf: Desktop Commander couldn't load its PDF writing support/.test(text(answer)),
    `write_pdf with markdown starting with a link, while PDF writing can't be loaded, should say it can't write links.pdf ` +
    `(markdown, as the tool reads it, not page edits); it answered: ${text(answer)}`);
  console.log(`✓ write_pdf with markdown starting with a link is writing a PDF: ${text(answer)}`);
}

/** The same call works once the package is loaded */
async function testSameCallWorksOnceLoaded(server, file) {
  assert((await callTool(server.client, 'read_file', { path: file })).trim().length > 0,
    'once PDF reading support has loaded, read_file of the PDF should return its text');
  console.log('✓ The same call works once PDF reading support has loaded');
}

/** A failed load isn't kept: the call says so, with the reason, and a later call loads it again */
async function testFailedLoadIsNotKept(server, file) {
  // Calls only once the background load has tried exceljs and logged the failure
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  while (!server.logs().some((line) => /Loading exceljs failed/.test(line)) && Date.now() < deadline) await sleep(100);
  const answer = await server.client.callTool({ name: 'read_file', arguments: { path: file } });
  assert(answer.isError === true && /Can't read held\.xlsx: Desktop Commander couldn't load its Excel support \(.*exceljs failed to load \(test\)/.test(text(answer)),
    `when exceljs failed to load, read_file of held.xlsx should say it can't read held.xlsx as Excel support couldn't be loaded, and why; it answered: ${text(answer)}`);
  assert(/ZebraQuartz held/.test(await callTool(server.client, 'read_file', { path: file })),
    'after a failed load, a later read_file of the .xlsx should load Excel support again and show its cells ' +
    '(Node keeps a failed import() failed, so it has to be loaded with require())');
  console.log(`✓ A failed load isn't kept: "${text(answer)}", and a later call loads it`);
}

/** A package Node can't load again (an import() that failed) says to restart, not to try again */
async function testFailedImportSaysRestart(server, file) {
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  while (!server.logs().some((line) => /Loading unpdf failed/.test(line)) && Date.now() < deadline) await sleep(100);
  const answer = await server.client.callTool({ name: 'read_file', arguments: { path: file } });
  assert(answer.isError === true &&
    /Can't read held\.pdf: Desktop Commander couldn't load its PDF reading support \(.*unpdf failed to load \(test\)\)\. Restart Desktop Commander/.test(text(answer)),
    'when unpdf failed to load, read_file of held.pdf should say to restart Desktop Commander: Node keeps a failed import() failed, ' +
    `so trying again can't work; it answered: ${text(answer)}`);
  console.log(`✓ A failed import() says to restart: ${text(answer)}`);
}

async function runCases(failures, cases) {
  for (const [check, ...args] of cases) {
    try {
      await check(...args);
    } catch (error) {
      failures.push(error);
      console.error(`❌ ${check.name}: ${error.message}`);
    }
  }
}

export default async function runTests() {
  if (!isTestHome()) {
    skip('test-startup-imports.js writes to the home: run it through node test/run-all-tests.js');
    return true;
  }
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'startup-imports-'));
  const failures = [];
  try {
    const server = await startServerRecordingModules();
    try {
      await runCases(failures, [
        [testNothingLoadedBeforeInitialize, server],
        [testLoadedSoonAfterInitialize, server],
        [testFilesWorkOnceLoaded, server, dir],
      ]);
    } finally {
      await server.close();
    }

    // PDF reading support held back: unpdf (loaded with import()) doesn't load
    // until the server is released
    const heldPdf = path.join(dir, 'held.pdf');
    const heldPdfToo = path.join(dir, 'held-too.pdf');
    fs.copyFileSync(SAMPLE_PDF, heldPdf);
    fs.copyFileSync(SAMPLE_PDF, heldPdfToo);
    const holding = await startServerRecordingModules({ holdPackage: 'unpdf' });
    try {
      await runCases(failures, [
        [testCallWhileLoadingAnswersAtOnce, holding, heldPdf],
        [testSameCallWorksOnceLoaded, holding, heldPdf],
      ]);
    } finally {
      await holding.close();
    }
    // A server of its own: after a call that succeeds, the server loads modules
    // of its own, which a held import would hold up (see startServerRecordingModules)
    const holdingToo = await startServerRecordingModules({ holdPackage: 'unpdf' });
    try {
      await runCases(failures, [[testReadMultipleFilesWhileLoading, holdingToo, heldPdf, heldPdfToo]]);
    } finally {
      await holdingToo.close();
    }

    // Excel support failing to load once
    const held = path.join(dir, 'held.xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1').addRow(['Item', 'ZebraQuartz held']);
    await workbook.xlsx.writeFile(held);
    const failing = await startServerRecordingModules({ failPackageOnce: 'exceljs' });
    try {
      await runCases(failures, [[testFailedLoadIsNotKept, failing, held]]);
    } finally {
      await failing.close();
    }

    // PDF reading support (unpdf, loaded with import()) failing to load once
    const failingImport = await startServerRecordingModules({ failPackageOnce: 'unpdf' });
    try {
      await runCases(failures, [[testFailedImportSaysRestart, failingImport, heldPdf]]);
    } finally {
      await failingImport.close();
    }

    // PDF writing failing to load once
    const failingPdf = await startServerRecordingModules({ failPackageOnce: 'md-to-pdf' });
    try {
      await runCases(failures, [[testWritePdfMarkdownStartingWithLink, failingPdf, dir]]);
    } finally {
      await failingPdf.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} startup import test(s) failed`);
    return false;
  }
  console.log('✅ Startup import tests passed');
  return true;
}

runIfMain(import.meta.url, runTests);
