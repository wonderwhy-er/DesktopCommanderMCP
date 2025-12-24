# Testing Strategy & Quality Assurance

## Overview

This document outlines comprehensive testing strategies for the Remote MCP extension, covering unit testing, integration testing, security testing, and performance validation across all three components.

## Testing Framework Architecture

### Test Pyramid Structure

```mermaid
graph TB
    A[End-to-End Tests<br/>10%] --> B[Integration Tests<br/>20%]
    B --> C[Unit Tests<br/>70%]
    
    subgraph "E2E Tests"
        A1[Full User Journeys]
        A2[Cross-Platform Testing]
        A3[Performance Testing]
    end
    
    subgraph "Integration Tests"
        B1[API Testing]
        B2[WebSocket Testing]
        B3[Database Testing]
        B4[Authentication Testing]
    end
    
    subgraph "Unit Tests"
        C1[Business Logic]
        C2[Utility Functions]
        C3[Error Handling]
        C4[Data Validation]
    end
```

## Unit Testing Strategy

### Jest Configuration
```typescript
// jest.config.ts
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000
};
```

### Unit Test Examples

#### Authentication Service Tests
```typescript
// src/services/__tests__/auth.test.ts
import { AuthenticationService } from '../auth-service';
import { JWTValidator } from '../jwt-validator';
import { MockRedisClient } from '../../__mocks__/redis';

describe('AuthenticationService', () => {
  let authService: AuthenticationService;
  let mockJWT: jest.Mocked<JWTValidator>;
  let mockRedis: MockRedisClient;

  beforeEach(() => {
    mockJWT = jest.mocked(new JWTValidator('secret'));
    mockRedis = new MockRedisClient();
    authService = new AuthenticationService(mockJWT, mockRedis);
  });

  describe('validateToken', () => {
    it('should validate a valid token', async () => {
      const token = 'valid.jwt.token';
      const expectedClaims = {
        sub: 'user-123',
        scope: 'mcp:execute',
        device_access: ['device-1']
      };

      mockJWT.verify.mockResolvedValue(expectedClaims);
      mockRedis.get.mockResolvedValue(null); // Not blacklisted

      const result = await authService.validateToken(token);

      expect(result).toEqual(expectedClaims);
      expect(mockJWT.verify).toHaveBeenCalledWith(token);
      expect(mockRedis.get).toHaveBeenCalledWith(`blacklist:${token}`);
    });

    it('should reject blacklisted tokens', async () => {
      const token = 'blacklisted.jwt.token';
      mockRedis.get.mockResolvedValue('blacklisted');

      await expect(authService.validateToken(token))
        .rejects.toThrow('Token has been revoked');

      expect(mockJWT.verify).not.toHaveBeenCalled();
    });

    it('should reject expired tokens', async () => {
      const token = 'expired.jwt.token';
      mockJWT.verify.mockRejectedValue(new Error('Token expired'));

      await expect(authService.validateToken(token))
        .rejects.toThrow('Token expired');
    });
  });

  describe('generateDeviceToken', () => {
    it('should generate token with correct claims', async () => {
      const device = {
        id: 'device-123',
        userId: 'user-456',
        name: 'Test Device'
      };

      const expectedToken = 'generated.jwt.token';
      mockJWT.sign.mockReturnValue(expectedToken);

      const result = await authService.generateDeviceToken(device);

      expect(result).toEqual(expectedToken);
      expect(mockJWT.sign).toHaveBeenCalledWith({
        sub: device.id,
        user_id: device.userId,
        aud: 'desktop-commander-agent',
        device_name: device.name
      }, { expiresIn: '30d' });
    });
  });
});
```

#### MCP Request Handler Tests
```typescript
// src/handlers/__tests__/mcp-request.test.ts
import { MCPRequestHandler } from '../mcp-request-handler';
import { MockDeviceRegistry } from '../../__mocks__/device-registry';
import { MockMessageQueue } from '../../__mocks__/message-queue';

describe('MCPRequestHandler', () => {
  let handler: MCPRequestHandler;
  let mockDeviceRegistry: MockDeviceRegistry;
  let mockMessageQueue: MockMessageQueue;

  beforeEach(() => {
    mockDeviceRegistry = new MockDeviceRegistry();
    mockMessageQueue = new MockMessageQueue();
    handler = new MCPRequestHandler(mockDeviceRegistry, mockMessageQueue);
  });

  describe('handleRequest', () => {
    it('should route request to single device', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 'test-1',
        method: 'read_file',
        params: { path: '/test/file.txt' },
        remote: { targetDevices: ['device-1'] }
      };

      const mockDevice = { id: 'device-1', status: 'online' };
      mockDeviceRegistry.getDevice.mockResolvedValue(mockDevice);
      mockMessageQueue.sendToDevice.mockResolvedValue({ 
        result: 'file contents' 
      });

      const result = await handler.handleRequest(request, { userId: 'user-1' });

      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        result: 'file contents',
        remote: {
          sourceDevice: 'device-1',
          executionTime: expect.any(Number)
        }
      });
    });

    it('should handle device offline errors', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 'test-2',
        method: 'read_file',
        params: { path: '/test/file.txt' },
        remote: { targetDevices: ['device-offline'] }
      };

      const mockDevice = { id: 'device-offline', status: 'offline' };
      mockDeviceRegistry.getDevice.mockResolvedValue(mockDevice);

      const result = await handler.handleRequest(request, { userId: 'user-1' });

      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 'test-2',
        error: {
          code: -32011,
          message: 'Device is offline',
          data: { deviceId: 'device-offline' }
        }
      });
    });

    it('should aggregate responses from multiple devices', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 'test-3',
        method: 'list_directory',
        params: { path: '/shared' },
        remote: { 
          targetDevices: ['device-1', 'device-2'],
          parallel: true,
          aggregation: 'merge'
        }
      };

      const mockDevices = [
        { id: 'device-1', status: 'online' },
        { id: 'device-2', status: 'online' }
      ];
      
      mockDeviceRegistry.getDevices.mockResolvedValue(mockDevices);
      mockMessageQueue.sendToDevices.mockResolvedValue([
        { result: ['file1.txt', 'file2.txt'], deviceId: 'device-1' },
        { result: ['file3.txt', 'file4.txt'], deviceId: 'device-2' }
      ]);

      const result = await handler.handleRequest(request, { userId: 'user-1' });

      expect(result.result).toEqual(['file1.txt', 'file2.txt', 'file3.txt', 'file4.txt']);
      expect(result.remote?.aggregated).toBe(true);
    });
  });
});
```

## Integration Testing

### API Integration Tests
```typescript
// tests/integration/api.test.ts
import request from 'supertest';
import { createTestApp } from '../helpers/test-app';
import { createTestDatabase } from '../helpers/test-database';
import { TestAuthHelper } from '../helpers/test-auth';

describe('API Integration Tests', () => {
  let app: any;
  let database: any;
  let authHelper: TestAuthHelper;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createTestApp(database);
    authHelper = new TestAuthHelper();
  });

  afterAll(async () => {
    await database.cleanup();
  });

  describe('Device Management', () => {
    let authToken: string;

    beforeEach(async () => {
      authToken = await authHelper.generateTestToken({
        userId: 'test-user-1',
        scope: 'mcp:execute mcp:admin'
      });
    });

    it('should register a new device', async () => {
      const deviceData = {
        name: 'Test Device',
        type: 'desktop',
        capabilities: ['filesystem', 'terminal']
      };

      const response = await request(app)
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${authToken}`)
        .send(deviceData)
        .expect(201);

      expect(response.body).toMatchObject({
        device: {
          name: 'Test Device',
          type: 'desktop',
          id: expect.any(String),
          registrationUrl: expect.any(String)
        }
      });
    });

    it('should list user devices', async () => {
      // Create test devices
      await database.devices.create({
        userId: 'test-user-1',
        name: 'Device 1',
        status: 'online'
      });

      const response = await request(app)
        .get('/api/v1/devices')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.devices).toHaveLength(1);
      expect(response.body.devices[0]).toMatchObject({
        name: 'Device 1',
        status: 'online'
      });
    });

    it('should reject requests without authentication', async () => {
      await request(app)
        .get('/api/v1/devices')
        .expect(401);
    });
  });

  describe('MCP Execution', () => {
    let authToken: string;
    let deviceId: string;

    beforeEach(async () => {
      authToken = await authHelper.generateTestToken({
        userId: 'test-user-1',
        scope: 'mcp:execute'
      });

      const device = await database.devices.create({
        userId: 'test-user-1',
        name: 'Test Device',
        status: 'online'
      });
      deviceId = device.id;
    });

    it('should execute MCP request on device', async () => {
      const mcpRequest = {
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'read_file',
        params: { path: '/test/file.txt' },
        remote: { targetDevices: [deviceId] }
      };

      // Mock device response
      jest.spyOn(messageQueue, 'sendToDevice')
        .mockResolvedValue({ result: 'file contents' });

      const response = await request(app)
        .post('/api/v1/mcp/execute')
        .set('Authorization', `Bearer ${authToken}`)
        .send(mcpRequest)
        .expect(200);

      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 'test-1',
        result: 'file contents'
      });
    });
  });
});
```

### WebSocket Integration Tests
```typescript
// tests/integration/websocket.test.ts
import { WebSocket } from 'ws';
import { createTestWebSocketServer } from '../helpers/test-websocket';
import { TestAuthHelper } from '../helpers/test-auth';

describe('WebSocket Integration Tests', () => {
  let wsServer: any;
  let authHelper: TestAuthHelper;

  beforeAll(async () => {
    wsServer = await createTestWebSocketServer();
    authHelper = new TestAuthHelper();
  });

  afterAll(async () => {
    await wsServer.close();
  });

  describe('Device Connection', () => {
    it('should accept authenticated device connections', async () => {
      const deviceToken = await authHelper.generateDeviceToken({
        deviceId: 'test-device-1',
        userId: 'test-user-1'
      });

      const ws = new WebSocket(`ws://localhost:${wsServer.port}/agent/connect`, {
        headers: {
          'Authorization': `Bearer ${deviceToken}`,
          'X-Device-ID': 'test-device-1'
        }
      });

      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('should reject unauthenticated connections', async () => {
      const ws = new WebSocket(`ws://localhost:${wsServer.port}/agent/connect`);

      await expect(new Promise((resolve, reject) => {
        ws.on('open', () => reject(new Error('Should not connect')));
        ws.on('error', resolve);
        ws.on('close', resolve);
      })).resolves.toBeTruthy();
    });

    it('should handle MCP request forwarding', async () => {
      const deviceToken = await authHelper.generateDeviceToken({
        deviceId: 'test-device-1',
        userId: 'test-user-1'
      });

      const ws = new WebSocket(`ws://localhost:${wsServer.port}/agent/connect`, {
        headers: {
          'Authorization': `Bearer ${deviceToken}`,
          'X-Device-ID': 'test-device-1'
        }
      });

      await new Promise(resolve => ws.on('open', resolve));

      const mcpRequest = {
        type: 'mcp_request',
        id: 'msg-123',
        payload: {
          jsonrpc: '2.0',
          id: 'mcp-1',
          method: 'read_file',
          params: { path: '/test/file.txt' }
        }
      };

      const responsePromise = new Promise(resolve => {
        ws.on('message', (data) => {
          const response = JSON.parse(data.toString());
          resolve(response);
        });
      });

      ws.send(JSON.stringify(mcpRequest));

      const response = await responsePromise;
      expect(response).toMatchObject({
        type: 'mcp_response',
        id: 'msg-123'
      });

      ws.close();
    });
  });
});
```

## End-to-End Testing

### Playwright E2E Tests
```typescript
// tests/e2e/user-journey.spec.ts
import { test, expect } from '@playwright/test';
import { TestEnvironment } from '../helpers/test-environment';

test.describe('Remote MCP User Journey', () => {
  let testEnv: TestEnvironment;

  test.beforeAll(async () => {
    testEnv = new TestEnvironment();
    await testEnv.setup();
  });

  test.afterAll(async () => {
    await testEnv.cleanup();
  });

  test('complete user onboarding and device setup', async ({ page }) => {
    // 1. User authentication
    await page.goto(testEnv.authUrl);
    await page.click('[data-testid="google-login"]');
    
    // Mock OAuth flow
    await page.route('**/oauth/google/callback', async route => {
      await route.fulfill({
        status: 302,
        headers: {
          'Location': `${testEnv.clientUrl}/auth/success?token=test-token`
        }
      });
    });

    await expect(page).toHaveURL(/auth\/success/);

    // 2. Device registration
    await page.click('[data-testid="add-device"]');
    await page.fill('[data-testid="device-name"]', 'My Test Device');
    await page.selectOption('[data-testid="device-type"]', 'desktop');
    await page.click('[data-testid="register-device"]');

    const deviceCode = await page.textContent('[data-testid="device-code"]');
    expect(deviceCode).toMatch(/[A-Z0-9]{6}/);

    // 3. Simulate device connection
    const deviceWS = await testEnv.connectDevice(deviceCode);
    await expect(page.locator('[data-testid="device-status"]')).toHaveText('Online');

    // 4. Execute MCP command
    await page.click('[data-testid="test-connection"]');
    await page.fill('[data-testid="command-input"]', 'read_file /etc/hostname');
    await page.click('[data-testid="execute-command"]');

    await expect(page.locator('[data-testid="command-result"]')).toContainText('hostname');
  });

  test('multi-device management', async ({ page }) => {
    await testEnv.setupMultipleDevices(3);
    
    await page.goto(testEnv.dashboardUrl);
    
    // Verify all devices are listed
    const deviceCards = page.locator('[data-testid="device-card"]');
    await expect(deviceCards).toHaveCount(3);

    // Execute command on all devices
    await page.click('[data-testid="select-all-devices"]');
    await page.fill('[data-testid="command-input"]', 'list_directory /home');
    await page.click('[data-testid="execute-parallel"]');

    // Verify aggregated results
    const results = page.locator('[data-testid="execution-results"]');
    await expect(results).toContainText('3 devices');
    await expect(results).toContainText('Aggregated');
  });

  test('error handling and recovery', async ({ page }) => {
    await testEnv.setupDeviceWithErrors();

    await page.goto(testEnv.dashboardUrl);
    
    // Execute command that will fail
    await page.fill('[data-testid="command-input"]', 'read_file /nonexistent/file');
    await page.click('[data-testid="execute-command"]');

    // Verify error handling
    const errorMessage = page.locator('[data-testid="error-message"]');
    await expect(errorMessage).toContainText('File not found');
    await expect(errorMessage).toHaveClass(/error/);

    // Test retry functionality
    await page.click('[data-testid="retry-button"]');
    await expect(page.locator('[data-testid="loading-indicator"]')).toBeVisible();
  });
});
```

## Performance Testing

### Load Testing with Artillery
```yaml
# tests/performance/load-test.yml
config:
  target: 'https://api.desktop.commander.app'
  phases:
    - duration: 60
      arrivalRate: 10
      name: "Warm up"
    - duration: 300
      arrivalRate: 50
      name: "Steady load"
    - duration: 120
      arrivalRate: 100
      name: "High load"
  variables:
    authToken: "{{ $processEnvironment.TEST_AUTH_TOKEN }}"

scenarios:
  - name: "MCP Request Execution"
    weight: 70
    flow:
      - post:
          url: "/api/v1/mcp/execute"
          headers:
            Authorization: "Bearer {{ authToken }}"
            Content-Type: "application/json"
          json:
            jsonrpc: "2.0"
            id: "{{ $uuid }}"
            method: "read_file"
            params:
              path: "/etc/hostname"
            remote:
              targetDevices: ["{{ $randomString(10) }}"]
          capture:
            - json: "$.result"
              as: "result"

  - name: "Device Management"
    weight: 20
    flow:
      - get:
          url: "/api/v1/devices"
          headers:
            Authorization: "Bearer {{ authToken }}"

  - name: "WebSocket Connection"
    weight: 10
    engine: ws
    flow:
      - connect:
          url: "wss://api.desktop.commander.app/agent/connect"
          headers:
            Authorization: "Bearer {{ authToken }}"
      - send: '{"type": "heartbeat", "timestamp": {{ $timestamp }}}'
      - think: 5
```

### WebSocket Performance Testing
```typescript
// tests/performance/websocket-load.ts
import { WebSocket } from 'ws';
import { performance } from 'perf_hooks';

interface LoadTestConfig {
  concurrentConnections: number;
  messagesPerConnection: number;
  messageInterval: number;
}

class WebSocketLoadTester {
  private connections: WebSocket[] = [];
  private metrics: {
    connectionsEstablished: number;
    messagesSent: number;
    messagesReceived: number;
    errors: number;
    latencies: number[];
  } = {
    connectionsEstablished: 0,
    messagesSent: 0,
    messagesReceived: 0,
    errors: 0,
    latencies: []
  };

  async runLoadTest(config: LoadTestConfig): Promise<void> {
    console.log(`Starting load test with ${config.concurrentConnections} connections`);

    // Establish connections
    const connectionPromises = Array(config.concurrentConnections)
      .fill(0)
      .map((_, index) => this.createConnection(index, config));

    await Promise.all(connectionPromises);

    // Wait for test completion
    await new Promise(resolve => setTimeout(resolve, config.messagesPerConnection * config.messageInterval + 5000));

    this.printMetrics();
    this.cleanup();
  }

  private async createConnection(index: number, config: LoadTestConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://api.desktop.commander.app/agent/connect', {
        headers: {
          'Authorization': `Bearer ${this.generateTestToken(index)}`,
          'X-Device-ID': `load-test-device-${index}`
        }
      });

      ws.on('open', () => {
        this.metrics.connectionsEstablished++;
        this.connections.push(ws);
        this.startMessageFlow(ws, config);
        resolve();
      });

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.timestamp) {
          const latency = performance.now() - message.timestamp;
          this.metrics.latencies.push(latency);
        }
        this.metrics.messagesReceived++;
      });

      ws.on('error', (error) => {
        this.metrics.errors++;
        console.error(`Connection ${index} error:`, error);
        reject(error);
      });
    });
  }

  private startMessageFlow(ws: WebSocket, config: LoadTestConfig): void {
    let messageCount = 0;
    
    const interval = setInterval(() => {
      if (messageCount >= config.messagesPerConnection) {
        clearInterval(interval);
        return;
      }

      const message = {
        type: 'mcp_request',
        id: `msg-${Date.now()}-${messageCount}`,
        timestamp: performance.now(),
        payload: {
          jsonrpc: '2.0',
          id: `mcp-${messageCount}`,
          method: 'read_file',
          params: { path: '/etc/hostname' }
        }
      };

      ws.send(JSON.stringify(message));
      this.metrics.messagesSent++;
      messageCount++;
    }, config.messageInterval);
  }

  private printMetrics(): void {
    const avgLatency = this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length;
    const p95Latency = this.metrics.latencies.sort()[Math.floor(this.metrics.latencies.length * 0.95)];

    console.log('Load Test Results:');
    console.log(`Connections Established: ${this.metrics.connectionsEstablished}`);
    console.log(`Messages Sent: ${this.metrics.messagesSent}`);
    console.log(`Messages Received: ${this.metrics.messagesReceived}`);
    console.log(`Errors: ${this.metrics.errors}`);
    console.log(`Average Latency: ${avgLatency.toFixed(2)}ms`);
    console.log(`P95 Latency: ${p95Latency.toFixed(2)}ms`);
  }
}
```

## Security Testing

### OWASP ZAP Security Scan
```yaml
# tests/security/zap-scan.yml
apiVersion: v1
kind: ConfigMap
metadata:
  name: zap-scan-config
data:
  scan.py: |
    #!/usr/bin/env python3
    import time
    from zapv2 import ZAPv2

    # Configure ZAP
    zap = ZAPv2(proxies={'http': 'http://localhost:8080', 'https': 'http://localhost:8080'})

    # Start ZAP daemon
    print('Starting ZAP passive scan...')

    # Spider the application
    target = 'https://api.desktop.commander.app'
    zap.spider.scan(target)
    
    while int(zap.spider.status()) < 100:
        print(f'Spider progress: {zap.spider.status()}%')
        time.sleep(2)

    # Active scan
    print('Starting active scan...')
    zap.ascan.scan(target)
    
    while int(zap.ascan.status()) < 100:
        print(f'Active scan progress: {zap.ascan.status()}%')
        time.sleep(5)

    # Generate report
    print('Generating security report...')
    report = zap.core.htmlreport()
    
    with open('/reports/security-report.html', 'w') as f:
        f.write(report)

    # Check for high-risk vulnerabilities
    alerts = zap.core.alerts(baseurl=target)
    high_risk = [alert for alert in alerts if alert['risk'] == 'High']
    
    if high_risk:
        print(f'CRITICAL: Found {len(high_risk)} high-risk vulnerabilities!')
        for alert in high_risk:
            print(f'- {alert["alert"]}: {alert["description"]}')
        exit(1)
    else:
        print('Security scan completed successfully!')
```

## Continuous Integration Testing

### GitHub Actions Test Workflow
```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20]
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: remotemcp_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      
      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
    - uses: actions/checkout@v4
    
    - name: Setup Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v4
      with:
        node-version: ${{ matrix.node-version }}
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run unit tests
      run: npm run test:unit
      env:
        DATABASE_URL: postgres://postgres:test@localhost:5432/remotemcp_test
        REDIS_URL: redis://localhost:6379
    
    - name: Upload coverage
      uses: codecov/codecov-action@v3

  integration-tests:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Setup test environment
      run: docker-compose -f docker-compose.test.yml up -d
    
    - name: Wait for services
      run: ./scripts/wait-for-services.sh
    
    - name: Run integration tests
      run: npm run test:integration
    
    - name: Cleanup
      run: docker-compose -f docker-compose.test.yml down

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Install Playwright
      run: npx playwright install
    
    - name: Start test environment
      run: npm run test:e2e:setup
    
    - name: Run E2E tests
      run: npm run test:e2e
    
    - name: Upload test artifacts
      uses: actions/upload-artifact@v3
      if: failure()
      with:
        name: playwright-report
        path: playwright-report/

  security-tests:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Run security audit
      run: npm audit --audit-level high
    
    - name: Run OWASP dependency check
      uses: dependency-check/Dependency-Check_Action@main
      with:
        project: 'remote-mcp'
        path: '.'
        format: 'JSON'
    
    - name: Run Snyk security scan
      uses: snyk/actions/node@master
      env:
        SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
```

This comprehensive testing strategy ensures high-quality, secure, and performant delivery of the Remote MCP extension across all components and user scenarios.