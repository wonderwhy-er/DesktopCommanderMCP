#!/usr/bin/env node

/**
 * Download all ripgrep binaries for cross-platform MCPB bundles
 * 
 * This script downloads ripgrep binaries for all supported platforms
 * and places them in node_modules/@vscode/ripgrep/bin/ with platform-specific names.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const yauzl = require('yauzl');
const { pipeline } = require('stream');

const streamPipeline = promisify(pipeline);

// Ripgrep versions from @vscode/ripgrep
const VERSION = 'v13.0.0-10';
const MULTI_ARCH_VERSION = 'v13.0.0-4';

// All supported platforms
const PLATFORMS = [
  { name: 'x86_64-apple-darwin', ext: 'tar.gz', version: VERSION },
  { name: 'aarch64-apple-darwin', ext: 'tar.gz', version: VERSION },
  { name: 'x86_64-pc-windows-msvc', ext: 'zip', version: VERSION },
  { name: 'aarch64-pc-windows-msvc', ext: 'zip', version: VERSION },
  { name: 'i686-pc-windows-msvc', ext: 'zip', version: VERSION },
  { name: 'x86_64-unknown-linux-musl', ext: 'tar.gz', version: VERSION },
  { name: 'aarch64-unknown-linux-musl', ext: 'tar.gz', version: VERSION },
  { name: 'i686-unknown-linux-musl', ext: 'tar.gz', version: VERSION },
  { name: 'arm-unknown-linux-gnueabihf', ext: 'tar.gz', version: MULTI_ARCH_VERSION },
  { name: 'powerpc64le-unknown-linux-gnu', ext: 'tar.gz', version: MULTI_ARCH_VERSION },
  { name: 's390x-unknown-linux-gnu', ext: 'tar.gz', version: VERSION }
];

const TEMP_DIR = path.join(__dirname, '../.ripgrep-downloads');
const OUTPUT_DIR = path.join(__dirname, '../node_modules/@vscode/ripgrep/bin');

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  📥 ${path.basename(dest)}...`);
    
    https.get(url, { 
      headers: { 
        'User-Agent': 'vscode-ripgrep',
        'Accept': 'application/octet-stream'
      }
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
      
      file.on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
    }).on('error', reject);
  });
}

async function extractZip(zipPath, outputDir, targetBinary) {
  const { execFileSync } = require('child_process');
  const pendingPath = path.join(outputDir, targetBinary + '.partial');
  const descriptor = fs.openSync(pendingPath, 'w');
  try {
    // The archive tool owns decompression and CRC validation. Await its terminal
    // status before publishing the binary; no pending stream can look complete.
    execFileSync('unzip', ['-p', path.basename(zipPath), 'rg.exe'], {
      cwd: path.dirname(zipPath), stdio: ['ignore', descriptor, 'pipe']
    });
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(pendingPath, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  fs.renameSync(pendingPath, path.join(outputDir, targetBinary));
}

async function extractTarGz(tarPath, outputDir, targetBinary) {
  const { execFileSync } = require('child_process');
  const tempExtractDir = fs.mkdtempSync(path.join(TEMP_DIR, 'extract-'));
  try {
    // A drive-qualified archive is parsed as a remote host by GNU tar. Resolve
    // the local archive through cwd and pass arguments without a shell.
    execFileSync('tar', ['-xzf', path.basename(tarPath), '-C', tempExtractDir], {
      cwd: path.dirname(tarPath), stdio: 'pipe'
    });
    const files = fs.readdirSync(tempExtractDir, { recursive: true });
    const rgFile = files.find(file => path.basename(file) === 'rg');
    if (!rgFile) throw new Error('ripgrep archive contains no rg binary: ' + tarPath);
    const destPath = path.join(outputDir, targetBinary);
    const pendingPath = path.join(tempExtractDir, 'rg-complete');
    fs.copyFileSync(path.join(tempExtractDir, rgFile), pendingPath);
    fs.chmodSync(pendingPath, 0o755);
    fs.renameSync(pendingPath, destPath);
  } finally {
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
}

async function downloadAndExtractPlatform(platform) {
  const { name, ext, version } = platform;
  const fileName = `ripgrep-${version}-${name}.${ext}`;
  const url = `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${version}/${fileName}`;
  const tempFile = path.join(TEMP_DIR, fileName);
  
  // Determine output binary name
  const isWindows = name.includes('windows');
  const binaryName = isWindows ? `rg-${name}.exe` : `rg-${name}`;
  const outputPath = path.join(OUTPUT_DIR, binaryName);
  
  // Skip if binary already exists
  if (fs.existsSync(outputPath)) {
    console.log(`  ✓ ${name} (cached)`);
    return;
  }
  
  // The release CDN returns the occasional 5xx, and a dropped connection can
  // leave a truncated archive behind, so retry from a clean temp file.
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Download if not already cached
      if (!fs.existsSync(tempFile)) {
        await downloadFile(url, tempFile);
      }

      // Extract
      ensureDir(OUTPUT_DIR);

      if (ext === 'zip') {
        await extractZip(tempFile, OUTPUT_DIR, binaryName);
      } else {
        await extractTarGz(tempFile, OUTPUT_DIR, binaryName);
      }

      console.log(`  ✓ ${name}`);
      return;
    } catch (error) {
      lastError = error;
      fs.rmSync(tempFile, { force: true });
      if (attempt === MAX_ATTEMPTS) break;
      const delayMs = RETRY_BASE_MS * attempt;
      console.warn(`  ⚠ ${name} attempt ${attempt}/${MAX_ATTEMPTS} failed (${error.message}) — retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }

  console.error(`  ✗ Failed: ${name} - ${lastError.message}`);
  throw lastError;
}

async function main() {
  console.log('🌍 Downloading ripgrep binaries for all platforms...\n');
  
  ensureDir(TEMP_DIR);
  ensureDir(OUTPUT_DIR);
  
  // Download and extract all platforms
  for (const platform of PLATFORMS) {
    await downloadAndExtractPlatform(platform);
  }
  
  console.log('\n✅ All ripgrep binaries downloaded successfully!');
  console.log(`📁 Binaries location: ${OUTPUT_DIR}`);
  console.log('\nFiles created:');
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith('rg-'));
  files.forEach(f => console.log(`   - ${f}`));
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });
}

module.exports = { downloadAndExtractPlatform, PLATFORMS };
