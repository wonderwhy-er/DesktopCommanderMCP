/**
 * edit_block on a DOCX "also searches headers/footers if not found in document
 * body", but it searched only header1-3.xml and footer1-3.xml. Word numbers
 * header and footer parts across sections: a second section with its own
 * header and footer gets header4.xml and footer4.xml. Their text shows in
 * read_file's outline, yet edit_block answered "Search string not found in
 * DOCX" for it and changed nothing.
 *
 * Expected: edit_block edits text in every header and footer part.
 * Runs the real server over stdio, as a client does.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runIfMain } from './helpers/run-if-main.js';
import { closeClient } from './helpers/close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PizZip = createRequire(import.meta.url)('pizzip');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const textOf = (result) => result.content?.[0]?.text ?? '';

/**
 * Turns the DOCX write_file made into a two-section document: section 1 with
 * default, first-page and even-page headers and footers (header1-3, footer1-3),
 * section 2 with its own (header4, footer4). Returns each part's text.
 */
function addSections(file) {
  const zip = new PizZip(fs.readFileSync(file));
  const parts = [];
  for (let n = 1; n <= 4; n++) {
    const label = n === 4 ? 'Section two' : `Section one ${['default', 'first', 'even'][n - 1]}`;
    parts.push({ name: `header${n}`, tag: 'hdr', kind: 'header', text: `${label} header` });
    parts.push({ name: `footer${n}`, tag: 'ftr', kind: 'footer', text: `${label} footer` });
  }
  let rels = zip.file('word/_rels/document.xml.rels')?.asText()
    ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let types = zip.file('[Content_Types].xml').asText();
  for (const part of parts) {
    zip.file(`word/${part.name}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${part.tag} xmlns:w="${W}" xmlns:r="${R}"><w:p><w:r><w:t>${part.text}</w:t></w:r></w:p></w:${part.tag}>`);
    rels = rels.replace('</Relationships>', `<Relationship Id="rId${part.name}" Type="${R}/${part.kind}" Target="${part.name}.xml"/></Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/word/${part.name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part.kind}+xml"/></Types>`);
  }
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('[Content_Types].xml', types);
  const refs = (names) => names.map(([kind, type, name]) => `<w:${kind}Reference w:type="${type}" r:id="rId${name}"/>`).join('');
  const sectionOne = `<w:p><w:pPr><w:sectPr>${refs([['header', 'default', 'header1'], ['header', 'first', 'header2'], ['header', 'even', 'header3'],
    ['footer', 'default', 'footer1'], ['footer', 'first', 'footer2'], ['footer', 'even', 'footer3']])}<w:titlePg/></w:sectPr></w:pPr></w:p>`;
  const document = zip.file('word/document.xml').asText()
    .replace(`<w:document xmlns:w="${W}">`, `<w:document xmlns:w="${W}" xmlns:r="${R}">`)
    .replace('<w:sectPr>', `${sectionOne}<w:p><w:r><w:t>Section two body</w:t></w:r></w:p><w:sectPr>${refs([['header', 'default', 'header4'], ['footer', 'default', 'footer4']])}`);
  zip.file('word/document.xml', document);
  fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return Object.fromEntries(parts.map((part) => [part.name, part.text]));
}

const partText = (file, name) => new PizZip(fs.readFileSync(file)).file(`word/${name}.xml`).asText();

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-docx-header-footer-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: 'docx-header-footer-test', version: '1.0.0' }, { capabilities: {} });
  const failures = [];
  try {
    await client.connect(transport, { timeout: 30_000 });
    const file = path.join(dir, 'sections.docx');
    await client.callTool({ name: 'write_file', arguments: { path: file, content: '# Title\n\nBody text' } });
    const texts = addSections(file);
    const outline = textOf(await client.callTool({ name: 'read_file', arguments: { path: file } }));

    // header3: the first section's even-page header (searched before too)
    for (const name of ['header3', 'header4', 'footer4']) {
      try {
        const result = await client.callTool({ name: 'edit_block', arguments: { file_path: file, old_string: `<w:t>${texts[name]}</w:t>`, new_string: `<w:t>${texts[name]} edited</w:t>` } });
        const shown = outline.includes(`${name}.xml: "${texts[name]}"`) ? 'shown in read_file\'s outline' : 'not in the outline';
        assert(!result.isError && partText(file, name).includes(`${texts[name]} edited`),
          `edit_block on the text of ${name}.xml (${shown}) answered "${textOf(result)}", and ${name}.xml is ${partText(file, name).includes(`${texts[name]} edited`) ? 'edited' : 'unchanged'}`);
        console.log(`✓ edit_block edits the text of ${name}.xml`);
      } catch (error) {
        failures.push(error);
        console.error(`✗ ${error.message}`);
      }
    }
  } finally {
    await closeClient(client);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  assert.deepStrictEqual(failures.map((error) => error.message), [], `${failures.length} check(s) failed`);
  return true;
}

runIfMain(import.meta.url, runTests);
