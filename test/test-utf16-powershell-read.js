import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileFromDisk } from '../dist/tools/filesystem.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-utf16-'));
const file = path.join(dir, 'powershell-output.txt');

try {
    // Match Windows PowerShell 5.1 redirection: FF FE BOM + UTF-16LE text.
    const lines = Array.from({ length: 1500 }, (_, i) =>
        i === 0 ? 'alpha' : i === 1 ? 'Rīga' : `line ${i + 1}`
    );
    const source = `${lines.join('\r\n')}\r\n`;
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]);
    await fs.writeFile(file, bytes);

    const first = await readFileFromDisk(file, { offset: 0, length: 3 });
    assert.equal(first.content.includes('\0'), false, 'read_file must not return embedded NULs');
    assert.equal(first.content.includes('\ufeff'), false, 'read_file must not return the BOM');
    assert.match(first.content, /^\[Reading 3 lines from start \(total: 1500 lines, 1497 remaining\)\]/);
    assert.match(first.content, /alpha\nRīga\nline 3$/);

    const middle = await readFileFromDisk(file, { offset: 500, length: 2 });
    assert.match(middle.content, /line 501\nline 502$/);

    const tail = await readFileFromDisk(file, { offset: -3 });
    assert.match(tail.content, /^\[Reading last 3 lines \(total: 1500 lines\)\]/);
    assert.match(tail.content, /line 1498\nline 1499\nline 1500$/);

    console.log('✓ PowerShell 5.1 UTF-16LE read_file decoding and pagination work');
} finally {
    await fs.rm(dir, { recursive: true, force: true });
}
