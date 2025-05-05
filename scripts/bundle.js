// Bundle script using ESBuild to prepare for SEA
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Read package.json to get entry points
const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
const mainEntry = resolve(rootDir, 'dist/index.js');
const setupEntry = resolve(rootDir, 'dist/setup-claude-server.js');

// Bundle the main app
await esbuild.build({
  entryPoints: [mainEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(rootDir, 'dist/bundle.js'),
  minify: true,
  banner: {
    js: `
      import { createRequire } from 'module';
      const require = createRequire(import.meta.url);
      import { dirname } from 'path';
      import { fileURLToPath } from 'url';
      const __dirname = dirname(fileURLToPath(import.meta.url));
    `
  },
  external: [
    // External native modules and modules that can't be bundled
    '@vscode/ripgrep',
    'child_process',
    'fs',
    'path',
    'url',
    'os',
    'util',
    'crypto',
    'stream',
    'zlib',
    'http',
    'https',
    'net',
    'tls'
  ]
});

console.log('Main application bundled successfully!');

// Bundle the setup script
await esbuild.build({
  entryPoints: [setupEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(rootDir, 'dist/setup-bundle.js'),
  minify: true,
  banner: {
    js: `
      import { createRequire } from 'module';
      const require = createRequire(import.meta.url);
      import { dirname } from 'path';
      import { fileURLToPath } from 'url';
      const __dirname = dirname(fileURLToPath(import.meta.url));
    `
  },
  external: [
    // External native modules and modules that can't be bundled
    'child_process',
    'fs',
    'path',
    'url',
    'os',
    'util',
    'crypto',
    'stream',
    'zlib',
    'http',
    'https',
    'net',
    'tls'
  ]
});

console.log('Setup script bundled successfully!');
