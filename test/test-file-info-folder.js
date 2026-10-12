/**
 * get_file_info describes "a file or directory", its type included, but on a
 * folder it answered "fileType: text": the file handler was chosen by the
 * folder's name and content as for a file (a folder named icons.png became an
 * image, "isImage: true"; any other one the text handler's "text").
 *
 * Expected: a folder is "fileType: directory", with the fields every folder
 * had before (size, times, isDirectory, isFile, permissions) and nothing a
 * file handler adds.
 * Runs the real server over stdio, as a client does.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runIfMain } from './helpers/run-if-main.js';
import { closeClient } from './helpers/close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER_FIELDS = ['size', 'created', 'modified', 'accessed', 'isDirectory', 'isFile', 'permissions', 'fileType'];

/** get_file_info's answer ("key: value" lines) as an object */
async function fileInfo(client, target) {
  const result = await client.callTool({ name: 'get_file_info', arguments: { path: target } });
  const text = result.content?.[0]?.text ?? '';
  assert(!result.isError, `get_file_info on a folder failed: ${text}`);
  return Object.fromEntries(text.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
}

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-file-info-folder-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: 'file-info-folder-test', version: '1.0.0' }, { capabilities: {} });
  const failures = [];
  try {
    await client.connect(transport, { timeout: 30_000 });
    // A plain folder (text handler before), one named like an image (image handler before)
    for (const name of ['somedir', 'icons.png']) {
      const folder = path.join(dir, name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'inside.txt'), 'a file inside');
      try {
        const info = await fileInfo(client, folder);
        assert.strictEqual(info.fileType, 'directory', `get_file_info on the folder ${name} says fileType: ${info.fileType}`);
        assert.strictEqual(info.isDirectory, 'true', `get_file_info on the folder ${name} says isDirectory: ${info.isDirectory}`);
        assert.deepStrictEqual(Object.keys(info), FOLDER_FIELDS, `get_file_info on the folder ${name} answers other fields than a folder's: ${Object.keys(info).join(', ')}`);
        console.log(`✓ get_file_info on the folder ${name}: fileType directory`);
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
