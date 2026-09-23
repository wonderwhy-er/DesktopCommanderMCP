import open from 'open';
import os from 'os';
import crypto from 'crypto';
import { captureRemote } from '../utils/capture.js';
import { observeServerDate } from './remote-channel.js';

interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
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
    device_id?: string;
}

const CLIENT_ID = 'mcp-device';

type DeviceAuthenticatorDeps = {
    fetch?: typeof fetch;
    open?: typeof open;
    capture?: typeof captureRemote;
    monotonicNow?: () => number;
};

export class DeviceAuthenticator {
    private baseServerUrl: string;
    private fetchFn: typeof fetch;
    private openFn: typeof open;
    private captureFn: typeof captureRemote;
    private monotonicNow: () => number;

    constructor(baseServerUrl: string, deps: DeviceAuthenticatorDeps = {}) {
        this.baseServerUrl = baseServerUrl;
        this.fetchFn = deps.fetch ?? fetch;
        this.openFn = deps.open ?? open;
        this.captureFn = deps.capture ?? captureRemote;
        this.monotonicNow = deps.monotonicNow ?? performance.now.bind(performance);
    }

    async authenticate(deviceId?: string): Promise<AuthSession> {
        console.log('🔐 Connecting this computer...\n');

        // Generate PKCE
        const pkce = this.generatePKCE();

        // Step 1: Request device code
        const deviceAuth = await this.requestDeviceCode(pkce.challenge, deviceId);

        // Step 2: Display user instructions and open browser
        this.displayUserInstructions(deviceAuth);

        // Step 3: Poll for authorization
        const tokens = await this.pollForAuthorization(deviceAuth, pkce.verifier);

        console.log('✅ Device verified\n');

        return tokens;
    }

    private generatePKCE() {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        return { verifier, challenge };
    }

    private async requestDeviceCode(codeChallenge: string, deviceId?: string): Promise<DeviceAuthResponse> {
        console.log('   - 📡 Requesting device code...');
        const startedAt = this.monotonicNow();
        await this.captureFn('remote_device_auth_request_started', {
            has_existing_device_id: Boolean(deviceId),
        });

        let response: Response;
        try {
            response = await this.fetchFn(`${this.baseServerUrl}/device/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: CLIENT_ID,
                    scope: 'mcp:tools',
                    device_name: os.hostname(),
                    device_type: 'mcp',
                    device_id: deviceId,
                    code_challenge: codeChallenge,
                    code_challenge_method: 'S256',
                }),
            });
        } catch (error) {
            await this.captureFn('remote_device_auth_request_network_error', {
                error,
                duration_ms: Math.round(this.monotonicNow() - startedAt),
                has_existing_device_id: Boolean(deviceId),
            });
            throw error;
        }
        observeServerDate(response.headers.get('date'));

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Unknown error' }));
            const errorMessage = error.error_description || 'Failed to start device flow';
            await this.captureFn('remote_device_auth_request_failed', {
                error: errorMessage,
                duration_ms: Math.round(this.monotonicNow() - startedAt),
                has_existing_device_id: Boolean(deviceId),
            });
            throw new Error(errorMessage);
        }

        const data = await response.json();
        await this.captureFn('remote_device_auth_code_received', {
            duration_ms: Math.round(this.monotonicNow() - startedAt),
            has_existing_device_id: Boolean(deviceId),
        });
        console.log('   - ✅ Device code received\n');
        return data;
    }

    private displayUserInstructions(deviceAuth: DeviceAuthResponse): void {
        console.log('📋 Please complete authentication:\n');
        console.log('   1. Verify this device in your browser:');
        console.log(`      ${deviceAuth.verification_uri_complete}\n`);
        console.log('   2. Make sure the code matches:');
        console.log(`      ${deviceAuth.user_code}\n`);
        console.log(`   Code expires in ${Math.floor(deviceAuth.expires_in / 60)} minutes.\n`);

        // Try to open browser automatically. This only confirms the OS accepted
        // the launch request; page-load completion is measured by the web event.
        void this.openFn(deviceAuth.verification_uri_complete)
            .then(() => this.captureFn('remote_device_browser_launch_succeeded'))
            .catch(async (error) => {
                await this.captureFn('remote_device_browser_launch_failed', { error });
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
                // The response that delivers the session states the server's
                // time; correct the clock before that session is used.
                observeServerDate(response.headers.get('date'));

                // Parse response body exactly once
                const data: PollResponse = await response.json().catch(() => ({ error: 'unknown' }));

                // Successful authentication
                if (response.ok && data.access_token) {
                    return {
                        device_id: data.device_id,
                        access_token: data.access_token,
                        refresh_token: data.refresh_token || null,
                    };
                }

                // Check error type
                if (data.error === 'authorization_pending') {
                    // Still waiting - continue polling
                    continue;
                }

                if (data.error === 'slow_down') {
                    // Server requested slower polling
                    await this.sleep(interval);
                    continue;
                }

                // Terminal error
                const errorMessage = data.error_description || data.error || 'Authorization failed';
                await captureRemote('remote_device_auth_failed', { error: errorMessage });
                throw new Error(errorMessage);
            } catch (fetchError) {
                // Network error - retry unless we're out of attempts
                if (attempt >= maxAttempts) {
                    await captureRemote('remote_device_auth_network_error', { error: fetchError });
                    throw fetchError;
                }
                // Continue polling on network errors
                continue;
            }
        }

        const timeoutError = 'Authorization timeout - user did not authorize within the time limit';
        await captureRemote('remote_device_auth_timeout', { error: timeoutError });
        throw new Error(timeoutError);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
