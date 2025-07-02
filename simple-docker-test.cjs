// Simple Docker detection test using CommonJS
const fs = require('fs');
const os = require('os');

console.log('🐳 Docker Detection Test (Simple)');
console.log('==================================\n');

// Test 1: Check for .dockerenv file (most reliable)
let dockerDetected = false;
let confidence = 0;
const evidence = [];

try {
  fs.readFileSync('/.dockerenv');
  dockerDetected = true;
  confidence += 70;
  evidence.push('/.dockerenv file exists');
  console.log('✅ /.dockerenv file found - Strong Docker indicator');
} catch (error) {
  console.log('❌ /.dockerenv file not found');
}

// Test 2: Check container environment variable
if (process.env.container === 'docker' || process.env.container === 'podman') {
  dockerDetected = true;
  confidence += 50;
  evidence.push(`container env var: ${process.env.container}`);
  console.log(`✅ Container environment variable: ${process.env.container}`);
} else {
  console.log('❌ No container environment variable');
}

// Test 3: Check hostname pattern (Docker containers often have 12-char hex names)
const hostname = process.env.HOSTNAME || os.hostname();
if (hostname && hostname.length === 12 && /^[a-f0-9]{12}$/.test(hostname)) {
  confidence += 25;
  evidence.push(`Docker-style hostname: ${hostname}`);
  console.log(`✅ Docker-style hostname detected: ${hostname}`);
} else {
  console.log(`❌ Normal hostname: ${hostname}`);
}

// Test 4: Check cgroup (Linux only)
if (os.platform() === 'linux') {
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (cgroup.includes('docker') || cgroup.includes('containerd')) {
      dockerDetected = true;
      confidence += 60;
      evidence.push('Docker detected in /proc/1/cgroup');
      console.log('✅ Docker found in /proc/1/cgroup');
    } else {
      console.log('❌ No Docker indicators in /proc/1/cgroup');
    }
  } catch (error) {
    console.log('❌ Cannot read /proc/1/cgroup');
  }
} else {
  console.log('ℹ️  Skipping cgroup check (not Linux)');
}

// Test 5: Check some environment variables
console.log('\n📊 Environment Analysis:');
console.log('========================');
console.log('Platform:', os.platform());
console.log('Architecture:', os.arch());
console.log('Node version:', process.version);
console.log('Hostname:', hostname);
console.log('USER:', process.env.USER || 'not set');
console.log('HOME:', process.env.HOME || 'not set');
console.log('PWD:', process.env.PWD || 'not set');

// Print relevant environment variables
const dockerEnvVars = Object.keys(process.env).filter(key => 
  key.toLowerCase().includes('docker') || 
  key.toLowerCase().includes('container')
);

if (dockerEnvVars.length > 0) {
  console.log('\n🐳 Docker-related environment variables:');
  dockerEnvVars.forEach(key => {
    console.log(`${key}: ${process.env[key]}`);
  });
}

// Final results
console.log('\n🎯 Detection Results:');
console.log('=====================');
console.log(`Docker Detected: ${dockerDetected ? '✅ YES' : '❌ NO'}`);
console.log(`Confidence: ${confidence}%`);
console.log(`Evidence: ${evidence.join(', ') || 'None'}`);

if (dockerDetected) {
  console.log('\n🎉 SUCCESS: Docker environment successfully detected!');
} else {
  console.log('\n⚠️  Docker not detected - this may be a false negative or not a Docker environment');
}

console.log('\n💡 For comparison, run this same test outside Docker to see the difference');
