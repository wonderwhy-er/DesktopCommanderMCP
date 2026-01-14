import open from 'open';
import os from 'os';
import crypto from 'crypto';

interface AuthSession {
    access_token: string;
    refresh_token: string | null;
}

interface DeviceAuthResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
}

interface PollResponse {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

const CLIENT_ID = 'mcp-device';

export class DeviceAuthenticator {
    private baseServerUrl: string;

    constructor(baseServerUrl: string) {
        this.baseServerUrl = baseServerUrl;
    }

    async authenticate(): Promise<AuthSession> {
        console.log('🔐 Starting device authorization flow...\n');

        // Generate PKCE
        const pkce = this.generatePKCE();

        // Step 1: Request device code
        const deviceAuth = await this.requestDeviceCode(pkce.challenge);

        // Step 2: Display user instructions and open browser
        this.displayUserInstructions(deviceAuth);

        // Step 3: Poll for authorization
        const tokens = await this.pollForAuthorization(deviceAuth, pkce.verifier);

        console.log('   - ✅ Authorization successful!\n');

        return tokens;
    }

    private generatePKCE() {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        return { verifier, challenge };
    }

    private async requestDeviceCode(codeChallenge: string): Promise<DeviceAuthResponse> {
        console.log('   - 📡 Requesting device code...');

        const response = await fetch(`${this.baseServerUrl}/device/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: 'mcp:tools',
                device_name: os.hostname(),
                device_type: 'mcp',
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(error.error_description || 'Failed to start device flow');
        }

        const data = await response.json();
        console.log('   - ✅ Device code received\n');
        return data;
    }

    private displayUserInstructions(deviceAuth: DeviceAuthResponse): void {
        console.log('📋 Please complete authentication:\n');
        console.log('   1. Open this URL in your browser:');
        console.log(`      ${deviceAuth.verification_uri}\n`);
        console.log('   2. Enter this code when prompted:');
        console.log(`      ${deviceAuth.user_code}\n`);
        console.log(`   Code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes.\n`);

        // Try to open browser automatically
        open(deviceAuth.verification_uri_complete).catch(() => {
            console.log('   - Could not open browser automatically.');
            console.log(`   - Please visit: ${deviceAuth.verification_uri}\n`);
        });

        console.log('   - ⏳ Waiting for authorization...\n');
    }

    private async pollForAuthorization(deviceAuth: DeviceAuthResponse, codeVerifier: string): Promise<AuthSession> {
        const interval = (deviceAuth.interval || 5) * 1000;
        const maxAttempts = Math.floor(deviceAuth.expires_in / (deviceAuth.interval || 5));
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;

            // Wait before polling
            await this.sleep(interval);

            try {
                const response = await fetch(`${this.baseServerUrl}/device/poll`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        device_code: deviceAuth.device_code,
                        client_id: CLIENT_ID,
                        code_verifier: codeVerifier,
                    }),
                });

                if (response.ok) {
                    const tokens: PollResponse = await response.json();
                    if (tokens.access_token) {
                        return {
                            access_token: tokens.access_token,
                            refresh_token: tokens.refresh_token || null,
                        };
                    }
                }

                const error: PollResponse = await response.json().catch(() => ({ error: 'unknown' }));

                // Check error type
                if (error.error === 'authorization_pending') {
                    // Still waiting - continue polling
                    continue;
                }

                if (error.error === 'slow_down') {
                    // Server requested slower polling
                    await this.sleep(interval);
                    continue;
                }

                // Terminal error
                throw new Error(error.error_description || error.error || 'Authorization failed');
            } catch (fetchError) {
                // Network error - retry unless we're out of attempts
                if (attempt >= maxAttempts) {
                    throw fetchError;
                }
                // Continue polling on network errors
                continue;
            }
        }

        throw new Error('Authorization timeout - user did not authorize within the time limit');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
