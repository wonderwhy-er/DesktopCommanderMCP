import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { DocxFileHandler } from '../dist/utils/files/docx.js';
import { runIfMain } from './helpers/run-if-main.js';

const PizZip = createRequire(import.meta.url)('pizzip');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export async function runTests() {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'dc-docx-whitespace-'));
  assert.strictEqual(path.dirname(directory), temporaryRoot);
  const failures = [];
  const cases = [
    ['document multiline text', 'word/document.xml', 'w:t', 'first\n  second'],
    ['document whitespace-only text', 'word/document.xml', 'w:t', '\n \t  '],
    ['document field instruction', 'word/document.xml', 'w:instrText', ' REF bookmark\n \\h '],
    ['header multiline text', 'word/header1.xml', 'w:t', 'first\n  second'],
    ['plain text control', 'word/document.xml', 'w:t', '  unchanged text  '],
  ];
  try {
    for (const [index, [name, part, tag, content]] of cases.entries()) {
      const file = path.join(directory, `${index}.docx`);
      const preserved = `<${tag} xml:space="preserve">${content}</${tag}>`;
      const paragraphs = `<w:p><w:r>${preserved}</w:r></w:p><w:p><w:r><w:t>replace me</w:t></w:r></w:p>`;
      const handler = new DocxFileHandler();
      await handler.write(file, 'Body');
      const zip = new PizZip(await fs.readFile(file));
      if (part === 'word/document.xml') {
        zip.file(part, zip.file(part).asText().replace(/<w:body>[\s\S]*?<w:sectPr>/, `<w:body>${paragraphs}<w:sectPr>`));
      } else {
        zip.file(part, `<w:hdr xmlns:w="${W}">${paragraphs}</w:hdr>`);
        const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="${relationships}/header" Target="header1.xml"/></Relationships>`);
        zip.file('[Content_Types].xml', zip.file('[Content_Types].xml').asText().replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'));
        zip.file('word/document.xml', zip.file('word/document.xml').asText()
          .replace('<w:document ', `<w:document xmlns:r="${relationships}" `)
          .replace('<w:sectPr>', '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/>'));
      }
      await fs.writeFile(file, zip.generate({ type: 'nodebuffer' }));
      try {
        for (const [oldText, newText] of [['replace me', 'updated'], ['updated', 'finished']]) {
          const result = await handler.editRange(file, '', {
            old_string: `<w:t>${oldText}</w:t>`,
            new_string: `<w:t>${newText}</w:t>`,
          });
          assert.strictEqual(result.success, true, JSON.stringify(result));
          const written = new PizZip(await fs.readFile(file)).file(part).asText();
          assert(written.includes(`<w:t>${newText}</w:t>`), 'the requested edit must be applied');
          assert(written.includes(preserved), `${name}: unrelated text must survive the edit verbatim`);
        }
        console.log(`PASS ${name}`);
      } catch (error) {
        failures.push(error.message);
        console.error(`FAIL ${error.message}`);
      }
    }
  } finally {
    assert.strictEqual(path.dirname(path.resolve(directory)), temporaryRoot);
    await fs.rm(directory, { recursive: true, force: true });
  }
  assert.deepStrictEqual(failures, []);
  return true;
}

runIfMain(import.meta.url, runTests);
