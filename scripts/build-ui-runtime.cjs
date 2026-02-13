#!/usr/bin/env node
/**
 * Build script that compiles and stages browser UI assets used by MCP tool pages. It centralizes bundling/runtime generation so UI resources are deterministic in local dev and CI.
 */
const path = require('path');
const fs = require('fs/promises');
const { build } = require('esbuild');

const target = process.argv[2];

const TARGETS = {
  'file-preview': {
    entry: 'src/ui/file-preview/src/main.ts',
    output: 'dist/ui/file-preview/preview-runtime.js',
    staticDir: 'src/ui/file-preview',
    styleLayers: [
      'src/ui/styles/base.css',
      'src/ui/styles/components/tool-header.css',
      'src/ui/styles/apps/file-preview.css'
    ]
  }
};

const STATIC_FILES = ['index.html'];
const projectRoot = path.resolve(__dirname, '..');

const selectedTargets =
  target
    ? [target]
    : Object.keys(TARGETS);

if (target && !TARGETS[target]) {
  console.error(
    `Usage: node scripts/build-ui-runtime.cjs [${Object.keys(TARGETS).join('|')}]`
  );
  process.exit(1);
}

async function buildTarget(targetName) {
  const { entry, output, staticDir, styleLayers } = TARGETS[targetName];
  const outputPath = path.join(projectRoot, output);
  const outputDir = path.dirname(outputPath);

  await fs.mkdir(outputDir, { recursive: true });

  for (const fileName of STATIC_FILES) {
    await fs.copyFile(
      path.join(projectRoot, staticDir, fileName),
      path.join(outputDir, fileName)
    );
  }

  const styles = await Promise.all(
    styleLayers.map((layerPath) => fs.readFile(path.join(projectRoot, layerPath), 'utf8'))
  );
  await fs.writeFile(path.join(outputDir, 'styles.css'), `${styles.join('\n\n')}\n`, 'utf8');

  await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    outfile: outputPath,
    minify: false,
    sourcemap: false
  });
}

async function main() {
  for (const targetName of selectedTargets) {
    await buildTarget(targetName);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
