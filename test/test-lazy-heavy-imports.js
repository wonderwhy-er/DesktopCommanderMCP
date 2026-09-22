/**
 * Pins down that exceljs, md-to-pdf and puppeteer load only when a session
 * uses them, and that an on-demand load which failed is retried, not
 * remembered. Needs Node >= 22.15 for module.registerHooks.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire, registerHooks } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Both slashes matter: they keep puppeteer from matching @puppeteer/browsers
// or puppeteer-core.
const HEAVY_PACKAGES = ['exceljs', 'md-to-pdf', 'puppeteer'];

const loadedUrls = new Set();

function startWatchingLoads() {
    if (typeof registerHooks !== 'function') return false;
    registerHooks({
        load(url, context, nextLoad) {
            loadedUrls.add(url);
            return nextLoad(url, context);
        },
    });
    return true;
}

function heavyPackagesLoaded() {
    // puppeteer is a dual package, so the CJS cache alone could miss it.
    const require = createRequire(path.join(REPO_ROOT, 'probe.cjs'));
    const seen = [
        ...Object.keys(require.cache).map((k) => k.split(path.sep).join('/')),
        ...loadedUrls,
    ];
    return HEAVY_PACKAGES.filter((pkg) => seen.some((k) => k.includes(`node_modules/${pkg}/`)));
}

function distUrl(...parts) {
    return pathToFileURL(path.join(REPO_ROOT, 'dist', ...parts)).href;
}

// Child mode: one probe per process, reported as a single RESULT line.
async function runProbe(name) {
    startWatchingLoads();

    if (name === 'startup') {
        // dist/index.js calls runServer() on its last line, so server.js is the
        // importable stand-in for the startup graph.
        await import(distUrl('server.js'));
        return { afterStartupImport: heavyPackagesLoaded() };
    }

    if (name === 'text-then-excel') {
        const { getFileHandler } = await import(distUrl('utils', 'files', 'factory.js'));

        const textHandler = await getFileHandler(path.join(REPO_ROOT, 'package.json'));
        const afterTextFile = heavyPackagesLoaded();

        // Extension-only routing, so the file need not exist.
        const excelHandler = await getFileHandler(path.join(REPO_ROOT, 'no-such-book.xlsx'));
        const afterExcelFile = heavyPackagesLoaded();

        return {
            textHandlerName: textHandler.constructor.name,
            excelHandlerName: excelHandler.constructor.name,
            afterTextFile,
            afterExcelFile,
        };
    }

    if (name === 'lazy-accessors') {
        // In the startup graph, so it must hold import() thunks and nothing else.
        await import(distUrl('tools', 'pdf', 'lazy.js'));
        return { afterAccessorImport: heavyPackagesLoaded() };
    }

    if (name === 'chrome-warmup') {
        const { chromeTools } = await import(distUrl('tools', 'pdf', 'lazy.js'));
        const tools = await chromeTools();
        return {
            afterChromeWarmup: heavyPackagesLoaded(),
            hasEnsureChromeAvailable: typeof tools.ensureChromeAvailable === 'function',
        };
    }

    if (name === 'pdf-tools') {
        const { pdfTools } = await import(distUrl('tools', 'pdf', 'lazy.js'));
        const tools = await pdfTools();
        return {
            afterPdfTools: heavyPackagesLoaded(),
            hasParseMarkdownToPdf: typeof tools.parseMarkdownToPdf === 'function',
        };
    }

    if (name === 'handler-load-retry') {
        // Node retries a failed dynamic import; a transient failure must not
        // decide that a whole file type is broken for the rest of the run.
        if (typeof registerHooks !== 'function') return { skipped: 'module.registerHooks unavailable' };

        const handlers = [
            { module: 'excel.js', sample: 'no-such-book.xlsx', expected: 'ExcelFileHandler' },
            { module: 'pdf.js', sample: 'no-such-doc.pdf', expected: 'PdfFileHandler' },
            { module: 'docx.js', sample: 'no-such-doc.docx', expected: 'DocxFileHandler' },
        ];

        const failOnce = new Set(handlers.map((h) => h.module));
        registerHooks({
            load(url, context, nextLoad) {
                for (const module of failOnce) {
                    if (url.endsWith(`/utils/files/${module}`)) {
                        failOnce.delete(module);
                        throw new Error(`simulated ${module} load failure`);
                    }
                }
                return nextLoad(url, context);
            },
        });

        const { getFileHandler } = await import(distUrl('utils', 'files', 'factory.js'));
        const results = [];

        for (const handler of handlers) {
            const sample = path.join(REPO_ROOT, handler.sample);

            let firstError = null;
            try { await getFileHandler(sample); } catch (e) { firstError = e.message; }

            let secondName = null;
            let secondError = null;
            try { secondName = (await getFileHandler(sample)).constructor.name; } catch (e) { secondError = e.message; }

            results.push({ module: handler.module, expected: handler.expected, firstError, secondName, secondError });
        }

        return { results };
    }

    if (name === 'concurrent-handlers') {
        const { getFileHandler } = await import(distUrl('utils', 'files', 'factory.js'));
        const results = [];

        for (const [file, expected] of [['a.xlsx', 'ExcelFileHandler'], ['a.pdf', 'PdfFileHandler'], ['a.docx', 'DocxFileHandler']]) {
            const sample = path.join(REPO_ROOT, file);
            const [first, second, third] = await Promise.all([
                getFileHandler(sample),
                getFileHandler(sample),
                getFileHandler(sample),
            ]);
            results.push({
                file,
                expected,
                handler: first.constructor.name,
                shared: first === second && second === third,
            });
        }

        return { results };
    }

    throw new Error(`unknown probe: ${name}`);
}

function probe(name) {
    const result = spawnSync(process.execPath, [__filename, '--probe', name], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        throw new Error(`probe "${name}" exited ${result.status}:\n${result.stderr || result.stdout}`);
    }
    const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    if (!line) {
        throw new Error(`probe "${name}" printed no RESULT line:\n${result.stdout}\n${result.stderr}`);
    }
    return JSON.parse(line.slice('RESULT '.length));
}

/**
 * Anchored on statement position on purpose: a bare search for `from <spec>`
 * also matches improved-process-tools.js, which documents an exceljs import
 * inside a prompt string, and would report a dependency the code lacks.
 */
function staticSpecifiers(source) {
    const specs = [];
    for (const m of source.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) {
        specs.push(m[1]);
    }
    for (const m of source.matchAll(/^[ \t]*import\s*['"]([^'"]+)['"]/gm)) {
        specs.push(m[1]);
    }
    return specs;
}

/**
 * dist/index.js cannot be imported — it calls runServer() — so the entry
 * point is checked by walking its static graph instead.
 */
function reachableBarePackages(entryFile) {
    const shortPath = (f) => path.relative(REPO_ROOT, f).split(path.sep).join('/');
    const visited = new Set();
    const bare = new Map();
    const unreadable = new Map();
    let filesRead = 0;
    const queue = [{ file: entryFile, importer: '(entry point)' }];

    while (queue.length > 0) {
        const { file, importer } = queue.pop();
        if (visited.has(file)) continue;
        visited.add(file);

        let source;
        try {
            source = fs.readFileSync(file, 'utf8');
            filesRead++;
        } catch {
            // Unreported, a pruned subtree would make case 6 go quiet instead of
            // failing, so the caller asserts this stayed empty.
            unreadable.set(shortPath(file), importer);
            continue;
        }

        for (const spec of staticSpecifiers(source)) {
            if (spec.startsWith('.')) {
                queue.push({ file: path.resolve(path.dirname(file), spec), importer: shortPath(file) });
            } else if (!bare.has(spec)) {
                bare.set(spec, shortPath(file));
            }
        }
    }

    return { bare, unreadable, filesRead };
}

function builtEntryPoint() {
    const entryPoint = path.join(REPO_ROOT, 'dist', 'index.js');
    assert.ok(fs.existsSync(entryPoint), `${entryPoint} not found — run npm run build first`);
    return entryPoint;
}

function readBuiltEntryPoint() {
    return fs.readFileSync(builtEntryPoint(), 'utf8');
}

const EXPECTED_CASES = 10;

let passed = 0;
let skipped = 0;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };
const skip = (msg) => { skipped++; console.log(`- SKIPPED: ${msg}`); };

async function run() {
    {
        const { afterStartupImport } = probe('startup');
        assert.deepStrictEqual(
            afterStartupImport,
            [],
            `importing dist/server.js loaded heavy packages: ${afterStartupImport.join(', ')}`
        );
        ok('importing the server module loads none of exceljs / md-to-pdf / puppeteer');
    }

    // The spreadsheet half is the control: without it, deleting Excel support
    // would pass.
    {
        const r = probe('text-then-excel');

        assert.strictEqual(r.textHandlerName, 'TextFileHandler', 'a .json path must route to TextFileHandler');
        assert.deepStrictEqual(
            r.afterTextFile,
            [],
            `routing a text file loaded heavy packages: ${r.afterTextFile.join(', ')}`
        );
        ok('routing a text file loads none of the heavy packages');

        assert.strictEqual(r.excelHandlerName, 'ExcelFileHandler', 'a .xlsx path must route to ExcelFileHandler');
        assert.ok(
            r.afterExcelFile.includes('exceljs'),
            'routing a .xlsx file must load exceljs on demand — deferred, not removed'
        );
        ok('routing a spreadsheet loads exceljs on first use');
    }

    // Control: a re-export in pdf/lazy.ts would put the modules back into
    // startup, and the source checks below would not see it.
    {
        const { afterAccessorImport } = probe('lazy-accessors');
        assert.deepStrictEqual(
            afterAccessorImport,
            [],
            `importing the PDF accessors loaded heavy packages: ${afterAccessorImport.join(', ')}`
        );
        ok('importing the PDF accessor module loads none of the heavy packages');
    }

    // Runs on every launch, so whatever it loads, every session pays for.
    {
        const r = probe('chrome-warmup');
        assert.ok(r.hasEnsureChromeAvailable, 'chromeTools() must still expose ensureChromeAvailable');
        assert.deepStrictEqual(
            r.afterChromeWarmup,
            [],
            `the startup Chrome warm-up loaded heavy packages: ${r.afterChromeWarmup.join(', ')}`
        );
        ok('the Chrome warm-up loads none of the heavy packages');
    }

    // Control for 4: without it, breaking PDFs would satisfy that case.
    {
        const r = probe('pdf-tools');
        assert.ok(r.hasParseMarkdownToPdf, 'pdfTools() must expose parseMarkdownToPdf');
        assert.ok(
            r.afterPdfTools.includes('md-to-pdf'),
            'using the PDF tools must load md-to-pdf on demand — deferred, not removed'
        );
        ok('using the PDF tools loads the renderer on first use');
    }

    // Cases 6 and 7 read the built artefact rather than watching a run, which
    // is the weaker evidence: they see what files spell out, not what loads.
    // They exist because dist/index.js cannot be imported at all.
    {
        const { bare, unreadable, filesRead } = reachableBarePackages(builtEntryPoint());

        const offenders = [...bare.entries()]
            .filter(([spec]) => HEAVY_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`)))
            .map(([spec, importer]) => `${spec} (imported by ${importer})`);

        assert.deepStrictEqual(
            offenders,
            [],
            `the entry point statically reaches heavy packages: ${offenders.join(', ')}`
        );

        // A pruned walk would hide an offender, so proving nothing is a failure.
        const stops = [...unreadable.entries()].map(([file, importer]) => `${file} (from ${importer})`);
        assert.deepStrictEqual(
            stops,
            [],
            `the import walk could not read: ${stops.join(', ')} — the graph was pruned, so this case proved less than it claims`
        );

        // A walk that reached almost nothing would satisfy both assertions above.
        assert.ok(
            filesRead > 10,
            `the import walk read only ${filesRead} file(s) — too few to have covered the entry point's graph`
        );

        ok(`nothing statically reachable from the entry point is a heavy package (${filesRead} files walked)`);
    }

    // Control: delete the warm-up call outright and every other case stays green.
    {
        const source = readBuiltEntryPoint();
        assert.ok(
            /chromeTools\s*\(/.test(source),
            'dist/index.js no longer calls chromeTools() — the Chrome warm-up was dropped'
        );
        ok('the entry point still runs the Chrome warm-up');
    }

    {
        const r = probe('handler-load-retry');
        if (r.skipped) {
            skip(`a failed handler load cannot be simulated here (${r.skipped})`);
        } else {
            for (const c of r.results) {
                assert.ok(c.firstError, `the first load of ${c.module} was supposed to fail — the probe did not simulate it`);
                assert.strictEqual(
                    c.secondError,
                    null,
                    `a retry after a failed ${c.module} load still fails: ${c.secondError}`
                );
                assert.strictEqual(c.secondName, c.expected, `the retry must produce a working ${c.expected}`);
            }
            ok(`a failed handler load is not cached — the next call retries (${r.results.length} handlers)`);
        }
    }

    // 9) Callers that arrive together share one instance. Sequential reuse is
    //    covered in test-docx-operations.js; this is the race, which a slot
    //    holding an instance rather than the load loses.
    {
        const r = probe('concurrent-handlers');
        for (const c of r.results) {
            assert.strictEqual(c.handler, c.expected, `${c.file} routed to ${c.handler}`);
            assert.ok(c.shared, `three parallel requests for ${c.file} produced more than one ${c.expected}`);
        }
        ok(`parallel requests share one handler (${r.results.length} types)`);
    }
}

if (process.argv[2] === '--probe') {
    runProbe(process.argv[3])
        .then((result) => { console.log(`RESULT ${JSON.stringify(result)}`); process.exit(0); })
        .catch((e) => { console.error(e.stack || e.message); process.exit(1); });
} else {
    run()
        .then(() => {
            // Asserted, not printed: a deleted case would otherwise report 8/9 and exit 0.
            assert.strictEqual(passed + skipped, EXPECTED_CASES,
                `expected ${EXPECTED_CASES} cases to report, got ${passed + skipped} — a case was removed or stopped reporting`);
            const summary = skipped > 0
                ? `PASS (${passed}/${EXPECTED_CASES}, ${skipped} skipped — see above)`
                : `PASS (${passed}/${EXPECTED_CASES})`;
            console.log(`\n${summary}`);
            process.exit(0);
        })
        .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
}
