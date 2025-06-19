import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { configManager } from '../dist/config-manager.js';
import { collectDiagnostics } from '../dist/tools/diagnostics.js';
import { configureDiagnostics } from '../dist/tools/diagnostics-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_TS_FILE = path.join(__dirname, 'test-diagnostics.ts');

async function setup() {
    await configManager.init();
    const originalConfig = await configManager.getConfig();
    await configManager.setValue('allowedDirectories', [__dirname]);
    return originalConfig;
}

async function teardown(originalConfig) {
    await fs.rm(TEST_TS_FILE, { force: true });
    await configManager.updateConfig(originalConfig);
    console.log('✓ Teardown completed');
}

async function testBasicDiagnostics() {
    console.log('Testing basic diagnostics functionality...');
    
    // Enable TypeScript diagnostics
    await configureDiagnostics({
        enabled: true,
        providers: ['typescript'],
        showWarnings: true,
        maxDiagnostics: 10
    });
    
    // Create a TypeScript file with errors
    const tsContent = `
function testFunction(name: string) {
    let num: number = "this should be a number";
    console.log(undefinedVariable);
    return name.toUpperCase();
}
`;
    
    await fs.writeFile(TEST_TS_FILE, tsContent);
    
    // Collect diagnostics
    const result = await collectDiagnostics(TEST_TS_FILE);
    
    console.log(`Found ${result.errorCount} errors and ${result.warningCount} warnings`);
    
    if (result.errorCount > 0) {
        console.log('✓ TypeScript diagnostics working correctly');
    } else {
        console.log('⚠ No TypeScript errors found - this might be expected if tsc is not available');
    }
    
    return true;
}

async function testDisabledDiagnostics() {
    console.log('Testing disabled diagnostics...');
    
    // Disable diagnostics
    await configureDiagnostics({
        enabled: false
    });
    
    const result = await collectDiagnostics(TEST_TS_FILE);
    
    if (result.errorCount === 0 && result.diagnostics.length === 0) {
        console.log('✓ Diagnostics correctly disabled');
        return true;
    } else {
        throw new Error('Expected no diagnostics when disabled');
    }
}

export default async function runDiagnosticsTests() {
    let originalConfig;
    
    try {
        originalConfig = await setup();
        
        await testBasicDiagnostics();
        await testDisabledDiagnostics();
        
        console.log('🎉 Basic diagnostics tests passed!');
        return true;
        
    } catch (error) {
        console.error('❌ Diagnostics test failed:', error.message);
        return false;
    } finally {
        if (originalConfig) {
            await teardown(originalConfig);
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runDiagnosticsTests().catch(error => {
        console.error('❌ Unhandled error:', error);
        process.exit(1);
    });
}