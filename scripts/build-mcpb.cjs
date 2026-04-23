#!/usr/bin/env node

/**
 * Build script for creating Desktop Commander MCPB bundle
 * 
 * This script:
 * 1. Uses esbuild to create a single-file ESM bundle
 * 2. Post-processes the bundle to fix esbuild ESM compatibility issues
 * 3. Creates a bundle directory structure 
 * 4. Generates a proper MCPB manifest.json
 * 5. Copies native dependencies that can't be bundled
 * 6. Uses mcpb CLI to create the final .mcpb bundle
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(PROJECT_ROOT, 'mcpb-bundle');
const MANIFEST_PATH = path.join(BUNDLE_DIR, 'manifest.json');

console.log('🏗️  Building Desktop Commander MCPB Bundle...');

// Step 0: Download all ripgrep binaries for cross-platform support
console.log('🌍 Downloading ripgrep binaries for all platforms...');
try {
    execSync('node scripts/download-all-ripgrep.cjs', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    console.log('✅ Ripgrep binaries downloaded');
} catch (error) {
    console.error('❌ Failed to download ripgrep binaries:', error.message);
    process.exit(1);
}

// Step 1: Clean and create bundle directory
console.log('🧹 Cleaning bundle directory...');
if (fs.existsSync(BUNDLE_DIR)) {
    fs.rmSync(BUNDLE_DIR, { recursive: true });
}
fs.mkdirSync(BUNDLE_DIR, { recursive: true });

// Step 2: Bundle with esbuild into a single ESM file
// Native modules (sharp, ripgrep) and CJS-only packages (pdf2md, pdf-lib) are kept external
console.log('📦 Bundling with esbuild...');
try {
    const distDir = path.join(BUNDLE_DIR, 'dist');
    fs.mkdirSync(distDir, { recursive: true });

    const externals = ['sharp', '@vscode/ripgrep', 'vscode', '@opendocsg/pdf2md', 'pdf-lib'];
    const externalFlags = externals.map(e => `--external:${e}`).join(' ');
    execSync(`npx esbuild src/index.ts --bundle --platform=node --target=node18 --format=esm --outfile=mcpb-bundle/dist/index.js ${externalFlags}`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    console.log('✅ esbuild bundling completed');

    // Step 2b: Post-process the bundle to fix esbuild ESM compatibility issues
    console.log('🔧 Post-processing bundle for ESM compatibility...');
    const bundlePath = path.join(BUNDLE_DIR, 'dist', 'index.js');
    let bundleContent = fs.readFileSync(bundlePath, 'utf8');

    // Fix 1: Inject ESM compatibility shims
    // esbuild's ESM format wraps CJS require() calls in a shim that throws at runtime.
    // We inject createRequire so Node.js built-ins (fs, path, child_process, etc.) work.
    // Also inject __dirname/__filename which CJS modules expect but ESM doesn't provide.
    const shebanLine = '#!/usr/bin/env node';
    const esmShims = [
        shebanLine,
        'import { createRequire as __bundleCreateRequire } from "module";',
        'import { fileURLToPath as __bundleFileURLToPath } from "url";',
        'import { dirname as __bundleDirname } from "path";',
        'var require = __bundleCreateRequire(import.meta.url);',
        'var __filename = __bundleFileURLToPath(import.meta.url);',
        'var __dirname = __bundleDirname(__filename);',
    ].join('\n');
    if (bundleContent.startsWith(shebanLine)) {
        bundleContent = bundleContent.replace(shebanLine, esmShims);
    } else {
        bundleContent = esmShims.replace(shebanLine + '\n', '') + '\n' + bundleContent;
    }
    console.log('  ✅ Injected ESM compatibility shims (createRequire, __dirname, __filename)');

    // Fix 2: Propagate async to __esm callbacks that contain await
    // esbuild bug: when module A has top-level await and module B imports from A,
    // esbuild correctly makes A's __esm callback async but fails to make B's async too.
    // This causes "SyntaxError: Unexpected reserved word" for await in non-async functions.
    // Fix: scan all __esm blocks and add async to any that contain await in their body.
    let fixCount = 0;
    const esmBlockRegex = /var (\w+) = __esm\(\{\n(\s+)(async )?"([^"]+)"\(\)/g;
    const fixes = [];
    let match;
    while ((match = esmBlockRegex.exec(bundleContent)) !== null) {
        if (match[3]) continue; // Already async
        const modName = match[4];
        const blockStart = match.index;
        const nextInit = bundleContent.indexOf('\nvar init_', blockStart + match[0].length);
        const blockEnd = nextInit !== -1 ? nextInit : blockStart + 10000;
        const blockBody = bundleContent.slice(blockStart, blockEnd);
        if (blockBody.includes('await ')) {
            fixes.push({
                position: match.index + match[0].indexOf(`"${modName}"()`),
                oldText: `"${modName}"()`,
                newText: `async "${modName}"()`
            });
        }
    }
    for (let i = fixes.length - 1; i >= 0; i--) {
        const fix = fixes[i];
        bundleContent = bundleContent.slice(0, fix.position) + fix.newText + bundleContent.slice(fix.position + fix.oldText.length);
        fixCount++;
    }
    if (fixCount > 0) {
        console.log(`  ✅ Fixed ${fixCount} non-async __esm callbacks containing await`);
    }

    // Fix 3: Remove the isMainModule auto-start block from device.ts
    // device.ts has a module-level guard: if (import.meta.url === process.argv[1]) { device.start() }
    // In the single-file bundle, import.meta.url always matches process.argv[1], so this
    // incorrectly starts the remote device on every run, outputting debug messages to stdout
    // which breaks Claude Desktop's JSON-RPC transport.
    const isMainModulePattern = /var isMainModule = process\.argv\[1\][\s\S]*?if \(isMainModule\) \{[\s\S]*?\n\}/;
    if (bundleContent.match(isMainModulePattern)) {
        bundleContent = bundleContent.replace(isMainModulePattern, '// [MCPB] Removed isMainModule auto-start block (not applicable in bundle context)');
        console.log('  ✅ Removed isMainModule auto-start block from device.ts');
    }

    fs.writeFileSync(bundlePath, bundleContent);
    console.log('✅ Post-processing completed');
} catch (error) {
    console.error('❌ esbuild bundling/post-processing failed:', error.message);
    process.exit(1);
}

// Step 3: Read package.json for version and metadata
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

// Step 4: Load and process manifest template
console.log('📝 Processing manifest template...');
const manifestTemplatePath = path.join(PROJECT_ROOT, 'manifest.template.json');
console.log(`📄 Using manifest: manifest.template.json`);
let manifestTemplate;
try {
    manifestTemplate = fs.readFileSync(manifestTemplatePath, 'utf8');
} catch (error) {
    console.error('❌ Failed to read manifest template:', manifestTemplatePath);
    process.exit(1);
}
const manifestContent = manifestTemplate.replace('{{VERSION}}', packageJson.version);
let manifest;
try {
    manifest = JSON.parse(manifestContent);
} catch (error) {
    console.error('❌ Invalid JSON in manifest template:', error.message);
    process.exit(1);
}
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('✅ Created manifest.json');

// Step 5: Copy necessary files (dist is generated by esbuild, not copied)
const filesToCopy = ['package.json', 'README.md', 'LICENSE', 'PRIVACY.md', 'icon.png'];
filesToCopy.forEach(file => {
    const srcPath = path.join(PROJECT_ROOT, file);
    const destPath = path.join(BUNDLE_DIR, file);
    if (fs.existsSync(srcPath)) {
        if (fs.statSync(srcPath).isDirectory()) {
            fs.cpSync(srcPath, destPath, { recursive: true });
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
        console.log(`✅ Copied ${file}`);
    } else {
        console.log(`⚠️  Skipped ${file} (not found)`);
    }
});

// Step 6: Create bundle package.json with only native/CJS-only dependencies
// Everything else is bundled by esbuild into the single dist/index.js file
const bundlePackageJson = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    type: "module",
    main: "dist/index.js",
    author: manifest.author,
    license: manifest.license,
    repository: manifest.repository,
    dependencies: {
        "sharp": packageJson.dependencies.sharp,
        "@vscode/ripgrep": packageJson.dependencies["@vscode/ripgrep"],
        "@opendocsg/pdf2md": packageJson.dependencies["@opendocsg/pdf2md"],
        "pdf-lib": packageJson.dependencies["pdf-lib"]
    }
};
fs.writeFileSync(
    path.join(BUNDLE_DIR, 'package.json'),
    JSON.stringify(bundlePackageJson, null, 2)
);

// Step 6b: Install dependencies in bundle directory
console.log('📦 Installing production dependencies in bundle...');
try {
    execSync('npm install --omit=dev --production', { cwd: BUNDLE_DIR, stdio: 'inherit' });
    console.log('✅ Dependencies installed');
} catch (error) {
    console.error('❌ Failed to install dependencies:', error.message);
    process.exit(1);
}

// Step 6c: Copy platform-specific ripgrep binaries and wrapper
console.log('🔧 Setting up cross-platform ripgrep support...');
try {
    const ripgrepBinSrc = path.join(PROJECT_ROOT, 'node_modules/@vscode/ripgrep/bin');
    const ripgrepBinDest = path.join(BUNDLE_DIR, 'node_modules/@vscode/ripgrep/bin');
    const ripgrepWrapperSrc = path.join(PROJECT_ROOT, 'scripts/ripgrep-wrapper.js');
    const ripgrepIndexDest = path.join(BUNDLE_DIR, 'node_modules/@vscode/ripgrep/lib/index.js');
    if (!fs.existsSync(ripgrepBinDest)) {
        fs.mkdirSync(ripgrepBinDest, { recursive: true });
    }
    const binaries = fs.readdirSync(ripgrepBinSrc).filter(f => f.startsWith('rg-'));
    binaries.forEach(binary => {
        const src = path.join(ripgrepBinSrc, binary);
        const dest = path.join(ripgrepBinDest, binary);
        fs.copyFileSync(src, dest);
        if (!binary.endsWith('.exe')) {
            fs.chmodSync(dest, 0o755);
        }
    });
    console.log(`✅ Copied ${binaries.length} ripgrep binaries`);
    fs.copyFileSync(ripgrepWrapperSrc, ripgrepIndexDest);
    console.log('✅ Installed ripgrep runtime wrapper');
} catch (error) {
    console.error('❌ Failed to setup ripgrep:', error.message);
    process.exit(1);
}

// Step 7: Validate manifest
console.log('🔍 Validating manifest...');
try {
    execSync(`npx @anthropic-ai/mcpb validate "${MANIFEST_PATH}"`, { stdio: 'inherit' });
    console.log('✅ Manifest validation passed');
} catch (error) {
    console.error('❌ Manifest validation failed:', error.message);
    process.exit(1);
}

// Step 8: Pack the bundle
console.log('📦 Creating .mcpb bundle...');
const outputFile = path.join(PROJECT_ROOT, `${manifest.name}-${manifest.version}.mcpb`);
try {
    execSync(`npx @anthropic-ai/mcpb pack "${BUNDLE_DIR}" "${outputFile}"`, { stdio: 'inherit' });
    console.log('✅ MCPB bundle created successfully!');
    console.log(`📁 Bundle location: ${outputFile}`);
} catch (error) {
    console.error('❌ Bundle creation failed:', error.message);
    process.exit(1);
}

console.log('');
console.log('🎉 Desktop Commander MCPB bundle is ready!');
console.log('');
console.log('Next steps:');
console.log('1. Test the bundle by installing it in Claude Desktop:');
console.log('   Settings → Extensions → Advanced Settings → Install Extension');
console.log(`2. Select the file: ${outputFile}`);
console.log('3. Configure any settings and test the functionality');
console.log('');
console.log('To submit to Anthropic directory:');
console.log('- Ensure privacy policy is accessible at the GitHub URL');
console.log('- Complete destructive operation annotations (✅ Done)');
console.log('- Submit via Anthropic desktop extensions interest form');
