#!/usr/bin/env node

/**
 * Build script for creating Desktop Commander MCPB bundle
 * 
 * This script:
 * 1. Builds the TypeScript project
 * 2. Creates a bundle directory structure 
 * 3. Generates a proper MCPB manifest.json with privacy policy
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
}
fs.mkdirSync(BUNDLE_DIR, { recursive: true });

// Step 3: Read package.json for version and metadata
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

// Step 4: Create MCPB manifest with privacy policy
const manifest = {
    manifest_version: "0.1",
    
    // Basic metadata
    name: "desktop-commander",
    display_name: "Desktop Commander",
    version: packageJson.version,
    description: "Execute long-running terminal commands and manage processes through Model Context Protocol (MCP)",
    
    // Author information as object
    author: {
        name: "Desktop Commander Team",
        url: "https://github.com/wonderwhy-er/DesktopCommanderMCP"
    },

    // Privacy policies - REQUIRED for Anthropic submission
    privacy_policies: [
        "https://legal.desktopcommander.app/privacy_desktop_commander_mcp"
    ],

    // Server configuration
    server: {
        type: "node",
        entry_point: "dist/index.js",
        mcp_config: {
            command: "node",
            args: ["${__dirname}/dist/index.js"],
            env: {
                NODE_ENV: "production"
            }
        }
    },

    // Optional fields
    homepage: "https://github.com/wonderwhy-er/DesktopCommanderMCP",
    repository: {
        type: "git",
        url: "https://github.com/wonderwhy-er/DesktopCommanderMCP.git"
    },

    // License
    license: "MIT",

    // Icon (if available)
    icon: "logo.png"
};

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
    'logo.png'
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

// Step 6: Create package.json in bundle for dependency info
const bundlePackageJson = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    main: "dist/index.js",
    author: manifest.author,
    license: manifest.license,
    repository: manifest.repository
};

fs.writeFileSync(
    path.join(BUNDLE_DIR, 'package.json'), 
    JSON.stringify(bundlePackageJson, null, 2)
);

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
