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
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName.endsWith('rg.exe')) {
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);

            const outputPath = path.join(outputDir, targetBinary);
            const writeStream = fs.createWriteStream(outputPath);
            
            readStream.pipe(writeStream);
            writeStream.on('close', () => {
              zipfile.close();
              resolve();
            });
            writeStream.on('error', reject);
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });
}

async function extractTarGz(tarPath, outputDir, targetBinary) {
  return new Promise((resolve, reject) => {
    const { execSync } = require('child_process');
    const tempExtractDir = path.join(TEMP_DIR, 'extract-' + Date.now());
    
    try {
      ensureDir(tempExtractDir);
      
      // Extract tar.gz
      execSync(`tar -xzf "${tarPath}" -C "${tempExtractDir}"`, { stdio: 'pipe' });
      
      // Find the rg binary
      const files = fs.readdirSync(tempExtractDir, { recursive: true });
      const rgFile = files.find(f => f.endsWith('/rg') || f === 'rg');
      
      if (rgFile) {
        const sourcePath = path.join(tempExtractDir, rgFile);
        const destPath = path.join(outputDir, targetBinary);
        fs.copyFileSync(sourcePath, destPath);
        fs.chmodSync(destPath, 0o755);
      }
      
      // Cleanup
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
      resolve();
    } catch (error) {
      reject(error);
    }
  });
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
  } catch (error) {
    console.error(`  ✗ Failed: ${name} - ${error.message}`);
    throw error;
  }
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
