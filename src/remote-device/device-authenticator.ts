import express, { Request, Response } from 'express';
import { createServer, Server } from 'http';
import open from 'open';
import readline from 'readline';

interface AuthSession {
    access_token: string;
    refresh_token: string | null;
}

interface CallbackQuery {
    access_token?: string;
    refresh_token?: string;
    code?: string;
    error?: string;
    error_description?: string;
    [key: string]: string | undefined;
}

function escapeHtml(text: string | null | undefined): string {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

const CALLBACK_PORT = 8121;

export class DeviceAuthenticator {
    private baseServerUrl: string;

    constructor(baseServerUrl: string) {
        this.baseServerUrl = baseServerUrl;
    }

    async authenticate(): Promise<AuthSession> {
        // Detect environment
        const isDesktop = this.isDesktopEnvironment();

        console.log(`🔐 Starting authentication (${isDesktop ? 'desktop' : 'headless'} mode)...`);

        if (isDesktop) {
            return this.authenticateDesktop();
        } else {
            return this.authenticateHeadless();
        }
    }

    private isDesktopEnvironment(): boolean {
        // Check if we're in a desktop environment
        return process.platform === 'darwin' ||
            process.platform === 'win32' ||
            (process.platform === 'linux' && !!process.env.DISPLAY);
    }

    private async authenticateDesktop(): Promise<AuthSession> {
        const app = express();
        const callbackUrl = `http://localhost:${CALLBACK_PORT}/callback`;

        return new Promise((resolve, reject) => {
            let server: Server;

            // Setup callback handler
            app.get('/callback', (req: Request<{}, {}, {}, CallbackQuery>, res: Response) => {
                const { access_token, refresh_token, code, error, error_description } = req.query;

                // Extract the actual token (could be in access_token or code parameter)
                const token = access_token || code;

                if (error) {
                    const safeError = escapeHtml(error);
                    const safeErrorDesc = escapeHtml(error_description || 'Unknown error');
                    res.send(`
            <h2>Authentication Failed</h2>
            <p>Error: ${safeError}</p>
            <p>Description: ${safeErrorDesc}</p>
            <p>You can close this window.</p>
          `);
                    server.close();
                    reject(new Error(`${error}: ${error_description}`));
                } else if (token) {
                    res.send(`
            <h2>Authentication Successful!</h2>
            <p>Your device is now connected.</p>
            <p>You can close this window.</p>
          `);
                    server.close();
                    console.log('   - ✅ Authentication successful, token received');
                    resolve({
                        access_token: token,
                        refresh_token: refresh_token || null
                    });
                } else {
                    console.log('❌ No token found in callback:', req.query);
                    const safeParams = escapeHtml(Object.keys(req.query).join(', '));
                    res.send(`
            <h2>Authentication Failed</h2>
            <p>No access token received</p>
            <p>Received parameters: ${safeParams}</p>
            <p>You can close this window.</p>
          `);
                    server.close();
                    reject(new Error('No access token received'));
                }
            });

            // Start callback server
            server = createServer(app);
            server.listen(CALLBACK_PORT, () => {
                const authUrl = `${this.baseServerUrl}/?redirect_uri=${encodeURIComponent(callbackUrl)}&device=true`;

                console.log('   - 🌐 Opening browser for authentication...');
                console.log(`   - If browser doesn't open, visit: ${authUrl}`);

                // Open browser
                open(authUrl).catch(() => {
                    console.log('   - Could not open browser automatically.');
                    console.log(`   - Please visit: ${authUrl}`);
                });
            });

            server.on('error', (err: Error) => {
                reject(new Error(`Failed to start callback server: ${err.message}`));
            });

            // Timeout after 5 minutes
            setTimeout(() => {
                if (server.listening) {
                    server.close();
                    reject(new Error('   - Authentication timeout - no response received'));
                }
            }, 5 * 60 * 1000);
        });
    }

    private async authenticateHeadless(): Promise<AuthSession> {
        console.log('\n🔗 Manual Authentication Required:');
        console.log('─'.repeat(50));
        console.log(`1. Open this URL in a browser: ${this.baseServerUrl}/`);
        console.log('2. Complete the authentication process');
        console.log('3. You will be redirected to a URL with parameters.');
        console.log('   If using device mode, look for access_token and refresh_token.');
        console.log('4. Copy the access_token (and refresh_token if available) and paste here.');
        console.log('   Format: access_token OR {"access_token":"...", "refresh_token":"..."}');
        console.log('─'.repeat(50));

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        return new Promise((resolve, reject) => {
            rl.question('\n🔑 Enter Access Token or JSON: ', (input) => {
                rl.close();

                const trimmedInput = input.trim();
                if (!trimmedInput) {
                    reject(new Error('Empty input provided'));
                    return;
                }

                try {
                    // Try parsing as JSON first
                    const json = JSON.parse(trimmedInput);
                    if (json.access_token) {
                        resolve({
                            access_token: json.access_token,
                            refresh_token: json.refresh_token || null
                        });
                        return;
                    }
                } catch (e) {
                    // Not JSON, treat as raw token
                }

                if (trimmedInput.length < 10) {
                    reject(new Error('Invalid token format (too short)'));
                } else {
                    resolve({
                        access_token: trimmedInput,
                        refresh_token: null
                    });
                }
            });
        });
    }
}
