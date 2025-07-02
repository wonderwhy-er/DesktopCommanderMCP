# Node.js Startup Detection Guide

This guide demonstrates how to detect how a Node.js application is being started (npm, npx, docker, node, etc.) and provides practical implementation examples.

## 🎯 Overview

Detecting how your Node.js server is started can be valuable for:
- **Logging & Analytics**: Understanding deployment patterns
- **Conditional Behavior**: Different features per environment
- **Error Handling**: Environment-specific error reporting
- **Performance Optimization**: Adjusting based on context
- **Security**: Enhanced monitoring in production

## 🔍 Detection Methods

### 1. NPM Run Scripts
**Detected by**: `npm_lifecycle_event` environment variable
```bash
npm run start        # npm_lifecycle_event = "start"
npm run dev          # npm_lifecycle_event = "dev"
npm run build        # npm_lifecycle_event = "build"
```

### 2. NPX Execution
**Detected by**: `npm_config_user_agent` containing "npx"
```bash
npx my-package       # npm_config_user_agent contains "npx"
npx @scope/package   # Temporary execution context
```

### 3. Docker Containers
**Detected by**: Multiple indicators
- `/.dockerenv` file existence (most reliable)
- `container=docker` environment variable
- Docker-style hostname patterns
- `/proc/1/cgroup` containing "docker" (Linux)

### 4. CI/CD Environments
**Detected by**: Platform-specific variables
- **GitHub Actions**: `GITHUB_ACTIONS=true`
- **GitLab CI**: `GITLAB_CI=true`
- **Jenkins**: `JENKINS_URL` exists
- **CircleCI**: `CIRCLECI=true`
- **Travis**: `TRAVIS=true`
- **Generic**: `CI=true`

### 5. Direct Node Execution
**Detected by**: Absence of package manager indicators
```bash
node server.js       # No npm/npx environment variables
node dist/index.js   # Direct execution
```

## 🚀 Implementation

### Production Module (`src/utils/startup-detector.ts`)

```typescript
import { getStartupInfo, getStartupMethod, isProduction, isDevelopment } from './utils/startup-detector.js';

// Get detailed information
const info = getStartupInfo();
console.log('Method:', info.method);           // 'npm-run', 'npx', 'docker', etc.
console.log('Environment:', info.environment); // 'production', 'development', 'ci', etc.
console.log('Confidence:', info.confidence);   // 0-100%

// Convenience functions
console.log('Startup:', getStartupMethod());   // "npm run start"
console.log('Is Production:', isProduction()); // boolean
console.log('Is Development:', isDevelopment()); // boolean
```

### Server Integration Example

```typescript
// In your main server file
import { getStartupInfo, getStartupMethod, isProduction } from './utils/startup-detector.js';

async function startServer() {
  const startupInfo = getStartupInfo();
  
  console.log(`🚀 Server starting via: ${getStartupMethod()}`);
  console.log(`📍 Environment: ${startupInfo.environment}`);
  
  // Conditional behavior
  if (isProduction()) {
    // Enhanced error handling for production
    setupProductionErrorHandling();
  }
  
  // Log for analytics
  analytics.track('server_startup', {
    method: startupInfo.method,
    environment: startupInfo.environment
  });
}
```

## 🧪 Testing

### 1. Basic Detection Test
```bash
node startup-detection-test.js
```

### 2. Comprehensive Testing
```bash
# Test all scenarios
node startup-detection-tester.js --all

# Test specific methods
node startup-detection-tester.js --npm
node startup-detection-tester.js --npx
node startup-detection-tester.js --docker
node startup-detection-tester.js --ci
```

### 3. Real-world Testing
```bash
# Build and test production module
npm run build
node startup-detection-tester.js --real-world
```

## 📊 Test Results Example

```
Detection Results:
------------------
NPM-RUN: ✅ DETECTED (70% confidence)
  - npm_lifecycle_event: start
  - npm_lifecycle_script: node dist/index.js

NPX: ❌ Not detected

DOCKER: ❌ Not detected

DIRECT-NODE: ❌ Not detected

CI-CD: ❌ Not detected

Summary:
--------
Most likely startup method: NPM-RUN
Confidence: High
```

## 🌍 Real-World Usage Scenarios

### 1. Development vs Production
```typescript
if (isDevelopment()) {
  // Enable debug features
  app.use(morgan('dev'));
  app.use(errorHandler({ dumpExceptions: true }));
} else if (isProduction()) {
  // Production optimizations
  app.use(compression());
  app.use(helmet());
}
```

### 2. Docker Environment
```typescript
if (isDocker()) {
  // Docker-specific configuration
  const port = process.env.PORT || 3000;
  const host = '0.0.0.0'; // Bind to all interfaces in Docker
  app.listen(port, host);
}
```

### 3. CI/CD Adjustments
```typescript
if (isCi()) {
  // Minimal logging in CI
  console.log = () => {}; // Suppress debug logs
  
  // Skip interactive prompts
  process.env.CI = 'true';
}
```

### 4. Analytics & Monitoring
```typescript
// Track deployment patterns
analytics.track('deployment', {
  method: getStartupInfo().method,
  environment: getStartupInfo().environment,
  timestamp: new Date().toISOString()
});

// Conditional monitoring
if (isProduction()) {
  setupErrorTracking();
  setupPerformanceMonitoring();
}
```

## 🔧 Integration with Desktop Commander

### Add to existing server startup:
```typescript
// In src/index.ts - add after imports
import { getStartupInfo, getStartupMethod, isProduction, isDevelopment, isDocker, isCi } from './utils/startup-detector.js';

// In runServer() function - add after argument checking
const startupInfo = getStartupInfo();
console.error(`🚀 Desktop Commander starting via: ${getStartupMethod()}`);
console.error(`📍 Environment: ${startupInfo.environment}`);

// Enhance error capture with startup context
capture('desktop_commander_startup', {
  startup_method: startupInfo.method,
  environment: startupInfo.environment,
  confidence: startupInfo.confidence
});
```

## 📋 Package.json Scripts

Add these scripts for easy testing:
```json
{
  "scripts": {
    "test:startup": "node startup-detection-tester.js --all",
    "test:startup-real": "node startup-detection-tester.js --real-world",
    "start:test": "npm start", 
    "start:docker": "docker run my-app",
    "start:direct": "node dist/index.js"
  }
}
```

## 🐳 Docker Testing

Create a test Dockerfile:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
CMD ["node", "dist/index.js"]
```

Test Docker detection:
```bash
docker build -t startup-test .
docker run startup-test
# Should detect method: 'docker', environment: 'container'
```

## 🤖 CI/CD Testing

GitHub Actions example:
```yaml
name: Test Startup Detection
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run build
      - run: npm start  # Should detect CI environment
```

## 🎛️ Configuration Options

The startup detector supports various confidence levels and detection methods:

- **High Confidence (70%+)**: Clear indicators present
- **Medium Confidence (40-69%)**: Some indicators present  
- **Low Confidence (<40%)**: Fallback detection

## 📈 Monitoring & Analytics

Track startup patterns over time:
```typescript
// Example analytics integration
const startupMetrics = {
  timestamp: Date.now(),
  method: getStartupInfo().method,
  environment: getStartupInfo().environment,
  version: process.version,
  platform: process.platform
};

// Send to your analytics service
analytics.track('server_startup', startupMetrics);
```

## 🔍 Debugging

Enable debug logging:
```typescript
// Add debug output
if (process.env.DEBUG_STARTUP) {
  const info = getStartupInfo();
  console.log('Startup Debug:', JSON.stringify(info, null, 2));
  console.log('Environment Variables:', Object.keys(process.env).filter(k => k.includes('npm')));
}
```

## 🚨 Limitations

1. **NPX Detection**: May not be 100% reliable in all environments
2. **Docker**: Requires file system access to check `/.dockerenv`
3. **CI/CD**: Based on environment variables that can be spoofed
4. **Parent Process**: Not always accessible on all platforms

## 💡 Best Practices

1. **Use for Enhancement**: Don't rely on detection for critical functionality
2. **Fallback Gracefully**: Always have default behavior
3. **Log Everything**: Include startup method in error reports
4. **Test Thoroughly**: Verify detection in your specific environment
5. **Monitor Production**: Track actual startup patterns

## 📚 Files Created

- `startup-detection-test.js` - Comprehensive detection analysis
- `startup-detection-tester.js` - Multi-scenario testing framework
- `src/utils/startup-detector.ts` - Production-ready module
- `test-startup-methods.js` - Manual testing guide
- This documentation file

## 🎉 Ready to Use!

Your startup detection system is now ready. The detection works across all major deployment scenarios and provides actionable insights for your Node.js server operations.
