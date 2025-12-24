# Security Architecture & Best Practices

## Overview

This document outlines comprehensive security measures, threat modeling, and best practices for the Remote MCP extension. Security is paramount when enabling remote machine access through cloud services.

## Threat Model

### Attack Vectors & Mitigations

#### 1. Authentication & Authorization Attacks

**Threats**:
- OAuth token theft or manipulation
- Privilege escalation attacks
- Session hijacking
- Credential stuffing attacks

**Mitigations**:
```typescript
// Multi-layered token validation
class SecurityValidator {
  async validateRequest(token: string, deviceId: string, request: MCPRequest): Promise<boolean> {
    // 1. JWT signature validation
    const tokenClaims = await this.jwtValidator.verify(token);
    
    // 2. Token freshness check
    if (this.isTokenExpired(tokenClaims)) {
      throw new AuthError('Token expired');
    }
    
    // 3. Device authorization check
    if (!tokenClaims.device_access.includes(deviceId)) {
      throw new AuthError('Device not authorized');
    }
    
    // 4. Rate limiting per user/device
    await this.rateLimiter.checkLimit(tokenClaims.sub, deviceId);
    
    // 5. Request scope validation
    if (!this.hasRequiredScope(tokenClaims.scope, request.method)) {
      throw new AuthError('Insufficient scope');
    }
    
    return true;
  }
}
```

#### 2. Network & Communication Attacks

**Threats**:
- Man-in-the-middle attacks
- Traffic interception and analysis
- DNS poisoning and redirect attacks
- WebSocket hijacking

**Mitigations**:
- **Certificate Pinning**: Pin cloud service certificates in agent
- **TLS 1.3 Only**: Enforce latest TLS version
- **HSTS Headers**: Prevent protocol downgrade attacks
- **Message Signing**: HMAC-SHA256 for critical operations

```typescript
// Certificate pinning implementation
class SecureWebSocketClient {
  private pinnedCertificates = [
    'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // Primary cert
    'sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='  // Backup cert
  ];

  async connect(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url, {
      checkServerIdentity: (servername, cert) => {
        const fingerprint = crypto.createHash('sha256')
          .update(cert.raw)
          .digest('base64');
        
        if (!this.pinnedCertificates.includes(`sha256/${fingerprint}`)) {
          throw new Error('Certificate pinning validation failed');
        }
      }
    });
    
    return ws;
  }
}
```

#### 3. Device & Agent Security

**Threats**:
- Compromised device credentials
- Malicious code execution
- Local privilege escalation
- Credential theft from device storage

**Mitigations**:
- **Secure Credential Storage**: OS keychain/credential manager
- **Code Signing**: Verify agent binary integrity
- **Sandboxing**: Limit agent process permissions
- **Regular Rotation**: Automatic credential refresh

```typescript
// Secure credential storage
class DeviceCredentialManager {
  async storeCredentials(credentials: DeviceCredentials): Promise<void> {
    if (process.platform === 'darwin') {
      // Use macOS Keychain
      await this.keychainService.store('remote-mcp-device', credentials);
    } else if (process.platform === 'win32') {
      // Use Windows Credential Manager
      await this.credManagerService.store('remote-mcp-device', credentials);
    } else {
      // Use encrypted file with libsodium
      await this.encryptedStorage.store(credentials);
    }
  }

  async rotateCredentials(): Promise<void> {
    const newCredentials = await this.cloudService.refreshDeviceToken();
    await this.storeCredentials(newCredentials);
    await this.establishNewConnection(newCredentials);
  }
}
```

#### 4. Cloud Infrastructure Attacks

**Threats**:
- DDoS attacks on API endpoints
- Database injection attacks
- Container escape and privilege escalation
- Infrastructure compromise

**Mitigations**:
- **Rate Limiting**: Multi-tier rate limiting
- **Input Validation**: Strict parameter validation
- **Container Security**: Non-root containers, read-only filesystems
- **Network Segmentation**: VPC isolation and security groups

## Security Implementation

### Authentication Flow Security

```typescript
// Secure OAuth implementation
class OAuthSecurityHandler {
  // PKCE (Proof Key for Code Exchange) implementation
  generateCodeChallenge(): { challenge: string, verifier: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256')
      .update(verifier)
      .digest('base64url');
    
    return { challenge, verifier };
  }

  async validateAuthorizationCode(
    code: string, 
    codeVerifier: string,
    clientId: string
  ): Promise<AuthTokens> {
    // Validate code challenge
    const storedChallenge = await this.redis.get(`challenge:${code}`);
    const computedChallenge = crypto.createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    
    if (storedChallenge !== computedChallenge) {
      throw new SecurityError('Invalid code verifier');
    }

    // Exchange code for tokens
    return await this.exchangeCodeForTokens(code, clientId);
  }
}
```

### Device Security Measures

```typescript
// Device integrity verification
class DeviceSecurityManager {
  async verifyDeviceIntegrity(): Promise<DeviceAttestation> {
    const attestation: DeviceAttestation = {
      deviceId: await this.getDeviceFingerprint(),
      osVersion: os.version(),
      agentVersion: this.getAgentVersion(),
      signature: '',
      timestamp: Date.now()
    };

    // Sign attestation with device private key
    attestation.signature = await this.signAttestation(attestation);
    
    return attestation;
  }

  private async getDeviceFingerprint(): Promise<string> {
    const machineId = await import('node-machine-id');
    const fingerprint = {
      machineId: machineId.machineIdSync(),
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      memory: os.totalmem()
    };

    return crypto.createHash('sha256')
      .update(JSON.stringify(fingerprint))
      .digest('hex');
  }
}
```

### Request Security & Validation

```typescript
// Comprehensive request validation
class RequestSecurityValidator {
  async validateMCPRequest(request: MCPRequest, context: SecurityContext): Promise<void> {
    // 1. Schema validation
    await this.validateSchema(request);
    
    // 2. Permission validation
    await this.validatePermissions(request, context);
    
    // 3. Resource limit validation
    await this.validateResourceLimits(request, context);
    
    // 4. Content security validation
    await this.validateContent(request);
  }

  private async validatePermissions(request: MCPRequest, context: SecurityContext): Promise<void> {
    const requiredPermissions = this.getRequiredPermissions(request.method);
    
    for (const permission of requiredPermissions) {
      if (!context.userPermissions.includes(permission)) {
        throw new SecurityError(`Missing permission: ${permission}`);
      }
    }

    // Validate path restrictions for file operations
    if (this.isFileOperation(request.method)) {
      await this.validatePathAccess(request.params?.path, context.allowedDirectories);
    }
  }

  private async validatePathAccess(path: string, allowedDirs: string[]): Promise<void> {
    const resolvedPath = require('path').resolve(path);
    
    // Check against allowed directories
    const isAllowed = allowedDirs.some(dir => 
      resolvedPath.startsWith(require('path').resolve(dir))
    );
    
    if (!isAllowed) {
      throw new SecurityError(`Path access denied: ${path}`);
    }

    // Check for path traversal attempts
    if (path.includes('..') || path.includes('~')) {
      throw new SecurityError(`Path traversal detected: ${path}`);
    }
  }
}
```

## Security Monitoring & Incident Response

### Security Event Logging

```typescript
// Comprehensive security logging
class SecurityAuditLogger {
  async logSecurityEvent(event: SecurityEvent): Promise<void> {
    const logEntry = {
      timestamp: new Date().toISOString(),
      eventType: event.type,
      severity: event.severity,
      userId: event.userId,
      deviceId: event.deviceId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      details: this.sanitizeDetails(event.details),
      outcome: event.outcome
    };

    // Log to multiple destinations
    await Promise.all([
      this.writeToAuditLog(logEntry),
      this.sendToSIEM(logEntry),
      this.alertIfCritical(logEntry)
    ]);
  }

  private async alertIfCritical(event: SecurityLogEntry): Promise<void> {
    if (event.severity === 'CRITICAL' || event.severity === 'HIGH') {
      await this.securityAlertService.sendAlert({
        type: 'security_incident',
        message: `Critical security event: ${event.eventType}`,
        details: event,
        timestamp: event.timestamp
      });
    }
  }
}
```

### Anomaly Detection

```typescript
// Real-time anomaly detection
class SecurityAnomalyDetector {
  private suspiciousPatterns = [
    { pattern: 'multiple_failed_auth', threshold: 5, window: 300 },
    { pattern: 'unusual_location', threshold: 1, window: 3600 },
    { pattern: 'high_request_rate', threshold: 1000, window: 60 },
    { pattern: 'privilege_escalation_attempt', threshold: 1, window: 1 }
  ];

  async analyzeUserBehavior(userId: string): Promise<AnomalyReport> {
    const recentActivity = await this.getRecentActivity(userId);
    const anomalies: Anomaly[] = [];

    for (const pattern of this.suspiciousPatterns) {
      const count = this.countPatternMatches(recentActivity, pattern);
      
      if (count >= pattern.threshold) {
        anomalies.push({
          type: pattern.pattern,
          count,
          threshold: pattern.threshold,
          risk: this.calculateRiskScore(pattern, count),
          recommended_action: this.getRecommendedAction(pattern)
        });
      }
    }

    return { userId, anomalies, timestamp: Date.now() };
  }

  private getRecommendedAction(pattern: SuspiciousPattern): string {
    switch (pattern.pattern) {
      case 'multiple_failed_auth':
        return 'temporary_account_lock';
      case 'unusual_location':
        return 'require_mfa_verification';
      case 'high_request_rate':
        return 'rate_limit_increase';
      case 'privilege_escalation_attempt':
        return 'immediate_session_termination';
      default:
        return 'investigate';
    }
  }
}
```

## Compliance & Data Protection

### GDPR Compliance

```typescript
// GDPR compliance implementation
class DataProtectionManager {
  async handleDataDeletionRequest(userId: string): Promise<void> {
    const deletionTasks = [
      this.deleteUserProfile(userId),
      this.deleteDeviceRegistrations(userId),
      this.deleteAuditLogs(userId),
      this.deleteAnalyticsData(userId),
      this.notifyThirdParties(userId)
    ];

    await Promise.all(deletionTasks);
    
    await this.logDataDeletion({
      userId,
      timestamp: Date.now(),
      requestedBy: 'user_request',
      dataTypes: ['profile', 'devices', 'logs', 'analytics']
    });
  }

  async generateDataExport(userId: string): Promise<UserDataExport> {
    return {
      profile: await this.getUserProfile(userId),
      devices: await this.getUserDevices(userId),
      usage_statistics: await this.getUserStats(userId),
      audit_logs: await this.getUserAuditLogs(userId),
      generated_at: new Date().toISOString()
    };
  }
}
```

### SOC 2 Type II Compliance

**Key Controls**:
- **Access Control**: Role-based access with regular reviews
- **Data Encryption**: AES-256 at rest, TLS 1.3 in transit
- **Monitoring**: 24/7 security monitoring and alerting
- **Incident Response**: Documented procedures with SLA commitments
- **Change Management**: Approved change processes with rollback procedures

## Security Testing Strategy

### Automated Security Testing

```typescript
// Security testing integration
class SecurityTestSuite {
  async runSecurityTests(): Promise<SecurityTestResults> {
    const results = await Promise.all([
      this.runVulnerabilityScans(),
      this.runPenetrationTests(),
      this.runComplianceChecks(),
      this.runDependencyAudits()
    ]);

    return this.aggregateResults(results);
  }

  private async runVulnerabilityScans(): Promise<VulnScanResults> {
    // Integration with OWASP ZAP, Snyk, etc.
    return await this.vulnerabilityScanner.scan({
      targets: ['https://api.desktop.commander.app'],
      depth: 'deep',
      authentication: this.getTestCredentials()
    });
  }
}
```

### Manual Security Reviews

**Regular Activities**:
- **Code Reviews**: Security-focused code review checklist
- **Architecture Reviews**: Threat modeling for new features
- **Penetration Testing**: Quarterly external security assessments
- **Red Team Exercises**: Annual red team engagement

This comprehensive security architecture ensures that the Remote MCP extension maintains the highest security standards while providing powerful remote machine management capabilities.