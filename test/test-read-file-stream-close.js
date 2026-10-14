/**
 * read_file and read_multiple_files close the file they read before they
 * return: when they stop at the line limit, read from the middle, read the
 * last lines, or fail half way.
 *
 * The user's symptom (#476, #631, #701): after read_file read part of a text
 * file, the file stayed open until Desktop Commander exited. On Windows,
 * another program then couldn't rename a new file over it (EPERM, "Access
 * denied"), as editors and build tools do when they save. The line reader
 * stopped at the line limit and closed itself, but not the file stream under it.
 *
 * Each case records the file streams the read opened and checks they are all
 * closed when the read returns. On Windows it also renames a new file over the
 * one just read, right after the read returns.
 */

import fs from 'fs';
import path from 'path';
import { handleReadFile, handleReadMultipleFiles } from '../dist/handlers/filesystem-handlers.js';
import { TextFileHandler } from '../dist/utils/files/text.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { createTempDir, isTestHome } from './helpers/test-env.js';

// Over the 10 MB where read_file switches to its large-file paths
const LARGE = 10.5 * 1024 * 1024;
const LARGE_MB = (LARGE / 1024 / 1024).toFixed(1);
const isWindows = process.platform === 'win32';

/** Numbered 99-character lines: `count` of them, or until they are over `bytes` */
function numberedLines({ count = Infinity, bytes = Infinity }) {
  const lines = [];
  for (let i = 1; i <= count && lines.length * 100 < bytes; i++) lines.push(`line ${i}`.padEnd(99, '.'));
  return lines;
}

/** The lines after read_file's "[Reading ...]" status line */
function linesOf(text) {
  return text.slice(text.indexOf('\n\n') + 2).split('\n');
}

/**
 * Runs `read` and returns the file streams it opened (every fs.ReadStream
 * passes through ReadStream.prototype._construct), with its result or error.
 * With `onSecondChunk`, calls it when one of those streams asks for its second
 * chunk, 64 KB into the file; when it returns true, that chunk isn't read and
 * `onSecondChunk` gets the read's callback instead.
 */
async function recordStreams(read, onSecondChunk) {
  const streams = [];
  const chunks = new Map();
  const construct = fs.ReadStream.prototype._construct;
  const fsRead = fs.read;
  fs.ReadStream.prototype._construct = function (callback) {
    streams.push(this);
    return construct.call(this, callback);
  };
  if (onSecondChunk) {
    fs.read = function (fd, ...args) {
      const stream = streams.find((candidate) => candidate.fd === fd);
      if (stream) {
        chunks.set(stream, (chunks.get(stream) ?? 0) + 1);
        if (chunks.get(stream) === 2 && onSecondChunk(args[args.length - 1])) return;
      }
      return fsRead.call(this, fd, ...args);
    };
  }
  try {
    return { streams, result: await read() };
  } catch (error) {
    return { streams, error };
  } finally {
    fs.ReadStream.prototype._construct = construct;
    fs.read = fsRead;
  }
}

export default async function runTests() {
  if (!isTestHome()) {
    return skip('test-read-file-stream-close reads through the config: run it through node test/run-all-tests.js');
  }
  const dir = createTempDir('dc-read-close-');
  const leftOpen = [];
  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? '✅' : '❌'} ${message}`);
    if (!condition) failures.push(message);
  };

  /** A new file of `lines` (UTF-8, or UTF-16 with its byte order mark) */
  const fileOf = (name, lines, encoding = 'utf8') => {
    const file = path.join(dir, name);
    const text = lines.join('\n');
    fs.writeFileSync(file, encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : text);
    return file;
  };

  /**
   * Runs `read` on `files`, then checks that every stream it opened is closed
   * and, on Windows, that a new file can be renamed over each file right away.
   * `outcome(result, error)` checks that the read itself did what it should.
   */
  const expectClosed = async (name, files, read, outcome, onSecondChunk) => {
    if (isWindows) files.forEach((file) => fs.writeFileSync(`${file}.new`, 'new\n'));
    const { streams, result, error } = await recordStreams(read, onSecondChunk);
    // At once, before anything else can run and close the file
    const renamed = isWindows ? files.map((file) => {
      try {
        fs.renameSync(`${file}.new`, file);
        return 'renamed';
      } catch (renameError) {
        return renameError.code ?? String(renameError);
      }
    }) : [];
    const open = streams.filter((stream) => !stream.closed);
    leftOpen.push(...open);

    outcome(result, error);
    check(streams.length > 0, `${name}: the read opened ${streams.length} file stream(s)`);
    const neverClosed = open.filter((stream) => !stream.destroyed).length;
    check(
      open.length === 0,
      `${name}: every file it opened is closed when it returns, got ${open.length} of ${streams.length} still open` +
        (open.length > 0 ? ` (${neverClosed} with nothing closing it, ${open.length - neverClosed} still closing)` : '')
    );
    if (isWindows) {
      check(
        renamed.every((outcome) => outcome === 'renamed'),
        `${name}: right after it returns, renaming a new file over the file it read works, got ${renamed.join(', ')}`
      );
    }
  };

  /** Checks that read_file returned `wanted` */
  const returns = (name, wanted) => (result, error) => {
    const got = error ? null : linesOf(result.content[0].text);
    check(
      got?.join('\n') === wanted.join('\n'),
      `${name} returns the lines it asked for, got ${error ? (error.stack ?? error) : `${got.length} lines from ${JSON.stringify(got[0]?.slice(0, 10))}`}`
    );
  };

  try {
    const lines = numberedLines({ count: 2000 });
    const large = numberedLines({ bytes: LARGE });

    // The first lines: the line reader stops at the limit
    {
      const file = fileOf('head.txt', lines);
      const name = 'read_file offset 0, length 5 on a 2000-line file';
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: 0, length: 5 }), returns(name, lines.slice(0, 5)));
    }

    // From the middle
    {
      const file = fileOf('middle.txt', lines);
      const name = 'read_file offset 1000, length 5 on a 2000-line file';
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: 1000, length: 5 }), returns(name, lines.slice(1000, 1005)));
    }

    // From the middle of a large file: past line 1000 it starts at the byte where that line starts
    {
      const file = fileOf('deep.txt', large);
      const name = `read_file offset 5000, length 5 on a ${LARGE_MB} MB file`;
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: 5000, length: 5 }), returns(name, large.slice(5000, 5005)));
    }

    // The last lines: the line reader reads the whole file
    {
      const file = fileOf('tail.txt', lines);
      const name = 'read_file offset -5 on a 2000-line file';
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: -5 }), returns(name, lines.slice(-5)));
    }

    // The last lines of a large file: found by reading backwards, then read from there
    {
      const file = fileOf('large-tail.txt', large);
      const name = `read_file offset -5 on a ${LARGE_MB} MB file`;
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: -5 }), returns(name, large.slice(-5)));
    }

    // UTF-16 (as Windows PowerShell 5.1 writes it): the first and the last lines
    {
      const file = fileOf('utf16-head.txt', lines, 'utf16le');
      const name = 'read_file offset 0, length 5 on a 2000-line UTF-16 file';
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: 0, length: 5 }), returns(name, lines.slice(0, 5)));
    }
    {
      const file = fileOf('utf16-tail.txt', lines, 'utf16le');
      const name = 'read_file offset -5 on a 2000-line UTF-16 file';
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: -5 }), returns(name, lines.slice(-5)));
    }

    // read_multiple_files reads each file up to the 1000-line default
    {
      const files = [fileOf('multiple-a.txt', lines), fileOf('multiple-b.txt', lines)];
      const name = 'read_multiple_files on two 2000-line files';
      await expectClosed(name, files, () => handleReadMultipleFiles({ paths: files }), (result, error) => {
        const read = error ? [] : files.filter((file) => result.content.some((item) => item.text?.includes(`--- ${file} contents: ---\n[Reading 1000 lines from start`)));
        check(read.length === 2, `${name} returns the first 1000 lines of both, got ${error ? (error.stack ?? error) : `${read.length} of them`}`);
      });
    }

    // A read error half way, as when a network drive drops
    {
      const file = fileOf('fails.txt', lines);
      const name = 'read_file offset 0, length 1500 with a read error 64 KB into the file';
      await expectClosed(name, [file], () => handleReadFile({ path: file, offset: 0, length: 1500 }),
        (result, error) => check(error?.code === 'EIO', `${name} fails with the read error, got ${error ? (error.code ?? error) : 'a result'}`),
        (callback) => {
          process.nextTick(callback, Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
          return true;
        });
    }

    // Aborted half way: read_file aborts the text read it runs when its 3-minute timeout ends
    {
      const file = fileOf('aborted.txt', lines);
      const name = 'the text read under read_file, offset -5, aborted 64 KB into the file';
      const controller = new AbortController();
      await expectClosed(name, [file], () => new TextFileHandler().read(file, { offset: -5, signal: controller.signal }),
        (result, error) => check(error?.name === 'AbortError', `${name} fails as aborted, got ${error ? error.name : 'a result'}`),
        () => {
          controller.abort();
          return false;
        });
    }
  } catch (error) {
    check(false, `unexpected error: ${error.stack ?? error}`);
  } finally {
    // Close what a read left open, so the folder can go
    await Promise.all(leftOpen.map((stream) => new Promise((resolve) => {
      if (stream.closed) return resolve();
      stream.once('close', resolve);
      stream.destroy();
    })));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
