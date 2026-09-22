/**
 * Pins down that a .docx still round-trips — written, read, edited through
 * edit_block — now that its handler arrives through await import(), and that
 * a repeated request reuses the handler already loaded.
 */

import assert from 'assert';
import { rmSync } from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// Before the first dist import: config.ts resolves the config path at load.
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-docx-home-'));
// Registered here, not after the imports below: one of them throwing would
// otherwise leave this directory on disk.
process.on('exit', () => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { configManager } = await import('../dist/config-manager.js');
const { getFileHandler } = await import('../dist/utils/files/factory.js');
const { readFile, writeFile } = await import('../dist/tools/filesystem.js');
const { handleEditBlock } = await import('../dist/handlers/edit-search-handlers.js');

const EXPECTED_CASES = 4;
let passed = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

const asText = (result) => (typeof result.content === 'string' ? result.content : String(result.content));

async function run() {
    // realpath so the allowed directory matches what validatePath resolves to.
    const workDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-docx-work-')));

    try {
        await configManager.setValue('allowedDirectories', [workDir]);

        const docxPath = path.join(workDir, 'note.docx');
        // A DOCX is a zip: without the PK check a text file named .docx would pass.
        {
            await writeFile(docxPath, 'Hello DOCX\n\nParagraph with MARKER-ONE inside.', 'rewrite');

            const bytes = await fsp.readFile(docxPath);
            assert.ok(bytes.length > 0, 'the written .docx is empty');
            assert.strictEqual(bytes.subarray(0, 2).toString('latin1'), 'PK', 'a .docx must be a zip container');
            ok(`writing a .docx produces a zip container (${bytes.length} bytes)`);
        }

        {
            const text = asText(await readFile(docxPath));
            assert.ok(text.includes('MARKER-ONE'), 'reading the .docx did not return the text that was written');
            ok('reading a .docx returns the text that was written');
        }

        {
            const result = await handleEditBlock({
                file_path: docxPath,
                old_string: 'MARKER-ONE',
                new_string: 'MARKER-TWO',
            });

            const reply = (result.content ?? []).map((c) => c.text ?? '').join('\n');
            assert.ok(!result.isError, `edit_block reported an error: ${reply}`);

            const text = asText(await readFile(docxPath));
            assert.ok(text.includes('MARKER-TWO'), `the edit did not land: ${reply}`);
            assert.ok(!text.includes('MARKER-ONE'), 'the replaced text is still in the document');
            ok('edit_block edits a .docx in place');
        }

        // Text is the control: it was never deferred.
        {
            const samples = [
                { file: 'again.docx', expected: 'DocxFileHandler' },
                { file: 'again.xlsx', expected: 'ExcelFileHandler' },
                { file: 'again.pdf', expected: 'PdfFileHandler' },
                { file: 'again.txt', expected: 'TextFileHandler' },
            ];

            for (const { file, expected } of samples) {
                const target = path.join(workDir, file);
                const first = await getFileHandler(target);
                const second = await getFileHandler(target);
                assert.strictEqual(first.constructor.name, expected, `${file} routed to ${first.constructor.name}`);
                assert.strictEqual(first, second, `${file} got a second ${expected} instance instead of the loaded one`);
            }

            ok(`a repeated request reuses the loaded handler (${samples.length} types)`);
        }
    } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

run()
    .then(() => {
        assert.strictEqual(passed, EXPECTED_CASES, `expected ${EXPECTED_CASES} cases, got ${passed}`);
        console.log(`\nPASS (${passed}/${EXPECTED_CASES})`);
        process.exit(0);
    })
    .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
