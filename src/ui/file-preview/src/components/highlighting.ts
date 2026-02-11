/**
 * Syntax highlighting integration layer around highlight.js. It registers supported languages and provides safe helpers for highlighted or plain escaped output.
 */
import { escapeHtml as sharedEscapeHtml } from '../../../shared/escape-html.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('toml', yaml);
hljs.registerLanguage('ini', yaml);

export function escapeHtml(input: string): string {
    return sharedEscapeHtml(input);
}

export function highlightSource(code: string, language: string): string {
    const normalizedLanguage = (language || '').toLowerCase();
    if (!normalizedLanguage || normalizedLanguage === 'text') {
        return escapeHtml(code);
    }

    try {
        if (hljs.getLanguage(normalizedLanguage)) {
            return hljs.highlight(code, { language: normalizedLanguage, ignoreIllegals: true }).value;
        }
        return hljs.highlightAuto(code).value;
    } catch {
        return escapeHtml(code);
    }
}
