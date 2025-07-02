#!/usr/bin/env node

/**
 * Simple Smithery Detection Test
 */

console.log('🧪 Testing Smithery Detection');
console.log('=============================\n');

console.log('Building project...');
try {
  const { execSync } = await import('child_process');
  execSync('npm run build', { cwd: process.cwd(), stdio: 'inherit' });
  console.log('✅ Build completed\n');
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}

console.log('🔍 Testing baseline (no Smithery indicators)...');
try {
  const { getStartupInfo, isSmithery, getStartupMethod } = await import('./dist/utils/startup-detector.js');
  
  const info = getStartupInfo();
  console.log(`Method: ${getStartupMethod()}`);
  console.log(`Environment: ${info.environment}`);
  console.log(`Is Smithery: ${isSmithery()}`);
  console.log(`Confidence: ${info.confidence}%`);
  console.log(`Evidence: ${info.details.evidence.join(', ') || 'None'}\n`);
  
} catch (error) {
  console.error('❌ Test failed:', error.message);
}

console.log('🔍 Testing simulated Smithery environment...');
// Set some Smithery-like environment variables
process.env.SMITHERY_SESSION_ID = '01932d4b-8f5e-7890-abcd-123456789abc';
process.env.SMITHERY_CLIENT = 'claude';
process.env.REGISTRY_ENDPOINT = 'https://api.smithery.ai/registry';

try {
  // Force re-detection by creating a new detector
  const { StartupDetector } = await import('./dist/utils/startup-detector.js');
  const detector = StartupDetector.getInstance();
  const info = detector.forceRedetect();
  
  console.log(`Method: ${detector.getStartupMethodString()}`);
  console.log(`Environment: ${info.environment}`);
  console.log(`Is Smithery: ${detector.isMethod('smithery')}`);
  console.log(`Confidence: ${info.confidence}%`);
  console.log(`Evidence: ${info.details.evidence.slice(0, 3).join(', ')}...`);
  
  if (info.details.smitheryClient) {
    console.log(`Smithery Client: ${info.details.smitheryClient}`);
  }
  
} catch (error) {
  console.error('❌ Test failed:', error.message);
}

console.log('\n✅ Smithery detection tests completed!');
