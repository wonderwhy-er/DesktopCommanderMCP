#!/usr/bin/env node

/**
 * write_pdf never runs code from a markdown header. gray-matter, which reads
 * the header (front matter), has a JavaScript engine: a `---js` or
 * `---javascript` header, or any header when its `language` option says
 * javascript, is evaluated in the server process. md-to-pdf switches that
 * engine off in its default gray_matter_options, but a caller's
 * gray_matter_options (even `{}`) replaced those defaults, so the engine was
 * on again. The caller's other gray-matter settings still apply.
 *
 * Calls resolveRender(), where write_pdf reads the header. Each header's code
 * would set a global in this process if it ran.
 */
import assert from 'assert';
import { resolveRender } from '../dist/tools/pdf/markdown.js';
import { runIfMain } from './helpers/run-if-main.js';

const MARKER = '__dcFrontMatterCodeRan';
const code = (label) => `{ title: (globalThis.${MARKER} = ${JSON.stringify(label)}, 'set by code') }`;

const cases = [
    ['a ---js header, gray_matter_options: {}', `---js\n${code('js')}\n---\n# Body\n`, { gray_matter_options: {} }],
    ['a ---javascript header, the caller\'s own engines map', `---javascript\n${code('javascript')}\n---\n# Body\n`, { gray_matter_options: { engines: {} } }],
    ['a plain header, the caller choosing the javascript language', `---\n${code('language')}\n---\n# Body\n`, { gray_matter_options: { language: 'javascript' } }],
    ['a ---js header, gray_matter_options: null', `---js\n${code('null')}\n---\n# Body\n`, { gray_matter_options: null }],
    ['a ---js header, the caller naming a js engine of its own', `---js\n${code('own js')}\n---\n# Body\n`, { gray_matter_options: { engines: { js: 'javascript' } } }],
    ['a ---js header, no gray_matter_options', `---js\n${code('default')}\n---\n# Body\n`, {}],
];

async function run() {
    const failures = [];
    for (const [what, markdown, options] of cases) {
        delete globalThis[MARKER];
        let outcome;
        try {
            const { options: merged } = resolveRender(markdown, options);
            outcome = `rendered with title ${JSON.stringify(merged.title)}`;
        } catch (error) {
            outcome = `refused: ${error.message}`;
        }
        try {
            assert.strictEqual(globalThis[MARKER], undefined,
                `write_pdf ran the code in the markdown's header in the server process (${what}; ${outcome})`);
            console.log(`✓ ${what}: the header's code did not run (${outcome})`);
        } catch (error) {
            failures.push(what);
            console.log(`✗ ${error.message}`);
        }
    }

    // The caller's other gray-matter settings still apply
    try {
        const { body, options: merged } = resolveRender('+++\ntitle: Kept\n+++\n# Body\n', { gray_matter_options: { delimiters: '+++' } });
        assert.strictEqual(merged.title, 'Kept', 'the caller\'s gray-matter delimiters should still find the header');
        assert(!body.includes('title: Kept'), `the header should not be part of the body: ${JSON.stringify(body)}`);
        console.log('✓ the caller\'s other gray-matter settings (delimiters) still apply');
    } catch (error) {
        failures.push('delimiters');
        console.log(`✗ ${error.message}`);
    }

    if (failures.length > 0) {
        console.log(`${failures.length} front matter check(s) failed`);
        return false;
    }
    return true;
}

runIfMain(import.meta.url, run);

export default run;
