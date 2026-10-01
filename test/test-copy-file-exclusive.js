import assert from 'assert';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { configManager } from '../dist/config-manager.js';
import { copyFileExclusive } from '../dist/tools/copy-file-exclusive.js';
import { handleCopyFileExclusive } from '../dist/handlers/filesystem-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, 'test_copy_file_exclusive');

const sha256 = (raw) => createHash('sha256').update(raw).digest('hex');

async function expectMissing(file) {
  try {
    await fs.lstat(file);
    assert.fail('expected path to be absent: ' + file);
  } catch (error) {
    assert.strictEqual(error.code, 'ENOENT');
  }
}

async function run() {
  let originalConfig;
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    originalConfig = await configManager.getConfig();
    await configManager.setValue('allowedDirectories', [TEST_DIR]);

    const source = path.join(TEST_DIR, 'source.bin');
    const destination = path.join(TEST_DIR, 'destination.bin');
    const mismatchDestination = path.join(TEST_DIR, 'mismatch.bin');
    const wrongSizeDestination = path.join(TEST_DIR, 'wrong-size.bin');

    const body = Buffer.concat([
      Buffer.from([0, 1, 2, 3, 255]),
      Buffer.from('CRLF\r\nLF\nUTF8:π🙂', 'utf8'),
      Buffer.from([10, 0, 13, 10]),
    ]);
    const digest = sha256(body);
    await fs.writeFile(source, body, { flag: 'wx', mode: 0o600 });

    const result = await copyFileExclusive(source, destination, body.length, digest);
    assert.strictEqual(result.bytes, body.length);
    assert.strictEqual(result.sha256, digest);
    assert.strictEqual(result.destinationSha256, digest);
    assert.strictEqual(result.independentInode, true);

    const [sourceRaw, destinationRaw, sourceStat, destinationStat] = await Promise.all([
      fs.readFile(source),
      fs.readFile(destination),
      fs.stat(source),
      fs.stat(destination),
    ]);
    assert.deepStrictEqual(sourceRaw, body);
    assert.deepStrictEqual(destinationRaw, body);
    assert.notDeepStrictEqual(
      [sourceStat.dev, sourceStat.ino],
      [destinationStat.dev, destinationStat.ino],
      'destination must be a distinct filesystem object',
    );

    const destinationBefore = await fs.readFile(destination);
    const destinationBeforeStat = await fs.stat(destination);
    await assert.rejects(
      copyFileExclusive(source, destination, body.length, digest),
      /EEXIST|exist/i,
    );
    assert.deepStrictEqual(await fs.readFile(destination), destinationBefore);
    const destinationAfterStat = await fs.stat(destination);
    assert.deepStrictEqual(
      [destinationAfterStat.dev, destinationAfterStat.ino],
      [destinationBeforeStat.dev, destinationBeforeStat.ino],
      'failed duplicate copy must preserve the existing destination inode',
    );

    await assert.rejects(
      copyFileExclusive(source, mismatchDestination, body.length, '0'.repeat(64)),
      /copy_source_digest/,
    );
    await expectMissing(mismatchDestination);

    await assert.rejects(
      copyFileExclusive(source, wrongSizeDestination, body.length + 1, digest),
      /copy_source_identity_or_size/,
    );
    await expectMissing(wrongSizeDestination);
    const handlerDestination = path.join(TEST_DIR, 'handler.bin');
    const handler = await handleCopyFileExclusive({
      source,
      destination: handlerDestination,
      expected_size: body.length,
      expected_sha256: digest,
    });
    assert.notStrictEqual(handler.isError, true);
    const payload = JSON.parse(handler.content[0].text);
    assert.strictEqual(payload.status, 'COPIED_EXCLUSIVE_VERIFIED');
    assert.strictEqual(payload.sha256, digest);
    assert.strictEqual(payload.destinationSha256, digest);

    const symlinkSource = path.join(TEST_DIR, 'source-link.bin');
    const symlinkDestination = path.join(TEST_DIR, 'symlink-copy.bin');
    try {
      await fs.symlink(source, symlinkSource);
      await assert.rejects(
        copyFileExclusive(symlinkSource, symlinkDestination, body.length, digest),
        /copy_source_regular_file_required/,
      );
      await expectMissing(symlinkDestination);
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      console.log('Symlink creation unavailable on this platform; symlink case skipped');
    }

    console.log('PASS copy_file_exclusive');
    return true;
  } finally {
    if (originalConfig) await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

[executed on device: trinity-do-engineering (c0baae6a-077b-4bca-854d-44acc8b544ea)]