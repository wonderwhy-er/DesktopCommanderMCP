#!/usr/bin/env node

/**
 * Build script for creating Desktop Commander MCPB bundle
 * 
 * This script:
 * 1. Builds the TypeScript project
 * 2. Creates a bundle directory structure 
 * 3. Generates a proper MCPB manifest.json
 * 4. Copies the built server and dependencies
 * 5. Uses mcpb CLI to create the final .mcpb bundle
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

// Step 1: Build the TypeScript project
console.log('📦 Building TypeScript project...');
try {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    console.log('✅ TypeScript build completed');
} catch (error) {
    console.error('❌ TypeScript build failed:', error.message);
    process.exit(1);
}

// Step 2: Clean and create bundle directory
if (fs.existsSync(BUNDLE_DIR)) {
    fs.rmSync(BUNDLE_DIR, { recursive: true });
}fs.mkdirSync(BUNDLE_DIR, { recursive: true });

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

// Replace template variables
const manifestContent = manifestTemplate.replace('{{VERSION}}', packageJson.version);

// Parse and validate the resulting manifest
let manifest;
try {
    manifest = JSON.parse(manifestContent);
} catch (error) {
    console.error('❌ Invalid JSON in manifest template:', error.message);
    process.exit(1);
}

// Write manifest
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('✅ Created manifest.json');
// Step 5: Copy necessary files
const filesToCopy = [
    'dist',
    'package.json',
    'README.md',
    'LICENSE',
    'PRIVACY.md',
    'icon.png'
];

filesToCopy.forEach(file => {
    const srcPath = path.join(PROJECT_ROOT, file);
    const destPath = path.join(BUNDLE_DIR, file);
    
    if (fs.existsSync(srcPath)) {
        if (fs.statSync(srcPath).isDirectory()) {
            // Copy directory recursively
            fs.cpSync(srcPath, destPath, { recursive: true });
        } else {
            // Copy file
            fs.copyFileSync(srcPath, destPath);
        }
        console.log(`✅ Copied ${file}`);
    } else {
        console.log(`⚠️  Skipped ${file} (not found)`);
    }
});

// Step 6: Create package.json in bundle with production dependencies
const bundlePackageJson = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    main: "dist/index.js",
    author: manifest.author,
    license: manifest.license,
    repository: manifest.repository,    dependencies: {
        "@modelcontextprotocol/sdk": "^1.9.0",
        "@vscode/ripgrep": "^1.15.9", 
        "cross-fetch": "^4.1.0",
        "fastest-levenshtein": "^1.0.16",
        "glob": "^10.3.10",
        "isbinaryfile": "^5.0.4",
        "zod": "^3.24.1",
        "zod-to-json-schema": "^3.23.5"
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
    
    // Ensure bin directory exists
    if (!fs.existsSync(ripgrepBinDest)) {
        fs.mkdirSync(ripgrepBinDest, { recursive: true });
    }
    
    // Copy all platform-specific ripgrep binaries
    const binaries = fs.readdirSync(ripgrepBinSrc).filter(f => f.startsWith('rg-'));
    binaries.forEach(binary => {
        const src = path.join(ripgrepBinSrc, binary);
        const dest = path.join(ripgrepBinDest, binary);
        fs.copyFileSync(src, dest);
        // Preserve executable permissions
        if (!binary.endsWith('.exe')) {
            fs.chmodSync(dest, 0o755);
        }
    });
    console.log(`✅ Copied ${binaries.length} ripgrep binaries`);
    
    // Replace index.js with our wrapper
    fs.copyFileSync(ripgrepWrapperSrc, ripgrepIndexDest);
    console.log('✅ Installed ripgrep runtime wrapper');
} catch (error) {
    console.error('❌ Failed to setup ripgrep:', error.message);
    process.exit(1);
}

// Step 7: Validate manifest
console.log('🔍 Validating manifest...');
try {
    execSync(`mcpb validate "${MANIFEST_PATH}"`, { stdio: 'inherit' });
    console.log('✅ Manifest validation passed');
} catch (error) {
    console.error('❌ Manifest validation failed:', error.message);
    process.exit(1);
}
// Step 8: Pack the bundle
console.log('📦 Creating .mcpb bundle...');
const outputFile = path.join(PROJECT_ROOT, `${manifest.name}-${manifest.version}.mcpb`);

try {
    execSync(`mcpb pack "${BUNDLE_DIR}" "${outputFile}"`, { stdio: 'inherit' });
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