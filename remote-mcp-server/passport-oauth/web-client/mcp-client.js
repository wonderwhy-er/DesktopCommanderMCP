/**
 * MCP Web Client with Direct SSE Connection and OAuth Authentication
 */

class MCPWebClient {
    constructor() {
        // Configuration
        this.mcpServerUrl = 'http://localhost:3006';
        this.oauthServerUrl = 'http://localhost:4449';
        
        // State
        this.accessToken = null;
        this.refreshToken = null;
        this.clientInfo = null;
        this.sseConnection = null;
        this.mcpInitialized = false;
        this.tools = [];
        this.messageId = 1;
        this.pendingRequests = new Map();
        
        // Initialize
        this.loadStoredTokens();
        this.updateUI();
        
        console.log('[MCP Client] Initialized');
        this.log('info', 'MCP Web Client ready');
    }

    /**
     * Update server configuration
     */
    updateConfiguration() {
        const mcpInput = document.getElementById('mcpServer');
        const oauthInput = document.getElementById('oauthServer');
        
        this.mcpServerUrl = mcpInput.value || 'http://localhost:3006';
        this.oauthServerUrl = oauthInput.value || 'http://localhost:4449';
        
        // Disconnect if connected
        if (this.sseConnection) {
            this.disconnectSSE();
        }
        
        this.log('info', `Configuration updated - MCP: ${this.mcpServerUrl}, OAuth: ${this.oauthServerUrl}`);
        this.updateUI();
    }

    /**
     * Test connectivity to both servers
     */
    async testConnectivity() {
        this.log('info', 'Testing server connectivity...');
        
        try {
            // Test OAuth server
            const oauthResponse = await fetch(`${this.oauthServerUrl}/health`);
            if (oauthResponse.ok) {
                this.log('success', `OAuth server healthy: ${this.oauthServerUrl}`);
            } else {
                this.log('error', `OAuth server error: ${oauthResponse.status}`);
            }
            
            // Test MCP server (without auth)
            const mcpResponse = await fetch(`${this.mcpServerUrl}/health`);
            if (mcpResponse.ok) {
                this.log('success', `MCP server healthy: ${this.mcpServerUrl}`);
            } else {
                this.log('error', `MCP server error: ${mcpResponse.status}`);
            }
            
        } catch (error) {
            this.log('error', `Connectivity test failed: ${error.message}`);
        }
    }

    /**
     * Start OAuth authentication flow
     */
    async authenticateOAuth() {
        try {
            this.log('info', 'Starting OAuth authentication flow...');
            
            // 1. Register OAuth client
            await this.registerOAuthClient();
            
            // 2. Generate PKCE parameters
            const pkceParams = await this.generatePKCE();
            
            // 3. Store PKCE for callback
            sessionStorage.setItem('pkce_verifier', pkceParams.code_verifier);
            sessionStorage.setItem('pkce_challenge', pkceParams.code_challenge);
            
            // 4. Redirect to authorization server
            const authUrl = this.buildAuthorizationUrl(pkceParams);
            this.log('info', 'Redirecting to OAuth authorization server...');
            
            window.location.href = authUrl;
            
        } catch (error) {
            this.log('error', `OAuth authentication failed: ${error.message}`);
        }
    }

    /**
     * Register OAuth client
     */
    async registerOAuthClient() {
        const registrationData = {
            client_name: 'MCP Web Client',
            redirect_uris: [window.location.origin + window.location.pathname],
            response_types: ['code'],
            grant_types: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_method: 'client_secret_post'
        };

        const response = await fetch(`${this.oauthServerUrl}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(registrationData)
        });

        if (!response.ok) {
            throw new Error(`Client registration failed: ${response.status}`);
        }

        this.clientInfo = await response.json();
        localStorage.setItem('oauth_client', JSON.stringify(this.clientInfo));
        
        this.log('success', `OAuth client registered: ${this.clientInfo.client_id}`);
    }

    /**
     * Generate PKCE parameters
     */
    async generatePKCE() {
        // Generate code verifier
        const codeVerifier = this.generateRandomString(128);
        
        // Generate code challenge
        const encoder = new TextEncoder();
        const data = encoder.encode(codeVerifier);
        const digest = await crypto.subtle.digest('SHA-256', data);
        const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');

        return {
            code_verifier: codeVerifier,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        };
    }

    /**
     * Generate random string for PKCE
     */
    generateRandomString(length) {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        let text = '';
        for (let i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Build authorization URL
     */
    buildAuthorizationUrl(pkceParams) {
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.clientInfo.client_id,
            redirect_uri: window.location.origin + window.location.pathname,
            scope: 'openid email profile mcp:tools',
            state: this.generateRandomString(32),
            code_challenge: pkceParams.code_challenge,
            code_challenge_method: 'S256'
        });

        return `${this.oauthServerUrl}/authorize?${params.toString()}`;
    }

    /**
     * Handle OAuth callback
     */
    async handleOAuthCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const error = urlParams.get('error');

        if (error) {
            this.log('error', `OAuth error: ${error} - ${urlParams.get('error_description')}`);
            return;
        }

        if (code) {
            try {
                this.log('info', 'Processing OAuth authorization code...');
                
                // Exchange code for tokens
                await this.exchangeCodeForTokens(code);
                
                // Clear URL parameters
                window.history.replaceState({}, document.title, window.location.pathname);
                
                this.updateUI();
                this.log('success', 'OAuth authentication completed successfully!');
                
            } catch (error) {
                this.log('error', `OAuth token exchange failed: ${error.message}`);
            }
        }
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeCodeForTokens(code) {
        const pkceVerifier = sessionStorage.getItem('pkce_verifier');
        if (!pkceVerifier) {
            throw new Error('PKCE verifier not found');
        }

        const tokenData = {
            grant_type: 'authorization_code',
            client_id: this.clientInfo.client_id,
            client_secret: this.clientInfo.client_secret,
            code: code,
            redirect_uri: window.location.origin + window.location.pathname,
            code_verifier: pkceVerifier
        };

        const response = await fetch(`${this.oauthServerUrl}/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(tokenData)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error_description || 'Token exchange failed');
        }

        const tokens = await response.json();
        this.accessToken = tokens.access_token;
        this.refreshToken = tokens.refresh_token;

        // Store tokens
        localStorage.setItem('access_token', this.accessToken);
        localStorage.setItem('refresh_token', this.refreshToken);
        
        // Clean up PKCE
        sessionStorage.removeItem('pkce_verifier');
        sessionStorage.removeItem('pkce_challenge');
    }

    /**
     * Load stored tokens
     */
    loadStoredTokens() {
        this.accessToken = localStorage.getItem('access_token');
        this.refreshToken = localStorage.getItem('refresh_token');
        const clientData = localStorage.getItem('oauth_client');
        if (clientData) {
            this.clientInfo = JSON.parse(clientData);
        }
    }

    /**
     * Logout - clear tokens
     */
    logout() {
        this.accessToken = null;
        this.refreshToken = null;
        this.clientInfo = null;
        
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('oauth_client');
        
        if (this.sseConnection) {
            this.disconnectSSE();
        }
        
        this.updateUI();
        this.log('info', 'Logged out successfully');
    }

    /**
     * Connect to SSE endpoint
     */
    connectSSE() {
        if (!this.accessToken) {
            this.log('error', 'OAuth authentication required before connecting');
            return;
        }

        this.log('info', 'Connecting to SSE endpoint...');

        try {
            const sseUrl = `${this.mcpServerUrl}/sse`;
            this.sseConnection = new EventSource(sseUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            this.sseConnection.onopen = () => {
                this.log('success', 'SSE connection established');
                this.updateUI();
            };

            this.sseConnection.onmessage = (event) => {
                this.handleSSEMessage(event);
            };

            this.sseConnection.onerror = (error) => {
                this.log('error', 'SSE connection error');
                console.error('SSE Error:', error);
                this.updateUI();
            };

            this.sseConnection.addEventListener('connected', (event) => {
                this.log('info', 'MCP server confirmed connection');
                const data = JSON.parse(event.data);
                console.log('Connected:', data);
            });

            this.sseConnection.addEventListener('heartbeat', (event) => {
                const data = JSON.parse(event.data);
                console.log('Heartbeat:', data);
            });

        } catch (error) {
            this.log('error', `SSE connection failed: ${error.message}`);
        }
    }

    /**
     * Disconnect SSE
     */
    disconnectSSE() {
        if (this.sseConnection) {
            this.sseConnection.close();
            this.sseConnection = null;
            this.mcpInitialized = false;
            this.log('info', 'SSE connection closed');
        }
        this.updateUI();
    }

    /**
     * Handle SSE messages
     */
    handleSSEMessage(event) {
        try {
            const message = JSON.parse(event.data);
            console.log('SSE Message:', message);
            
            // Handle MCP protocol messages
            if (message.id && this.pendingRequests.has(message.id)) {
                const resolve = this.pendingRequests.get(message.id);
                this.pendingRequests.delete(message.id);
                resolve(message);
            }
            
        } catch (error) {
            console.error('Error parsing SSE message:', error);
        }
    }

    /**
     * Initialize MCP protocol
     */
    async initializeMCP() {
        if (!this.sseConnection) {
            this.log('error', 'SSE connection required for MCP initialization');
            return;
        }

        try {
            this.log('info', 'Initializing MCP protocol...');
            
            const initRequest = {
                jsonrpc: '2.0',
                id: this.messageId++,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {}
                    },
                    clientInfo: {
                        name: 'MCP Web Client',
                        version: '1.0.0'
                    }
                }
            };

            const response = await this.sendMCPMessage(initRequest);
            
            if (response.result) {
                this.mcpInitialized = true;
                this.log('success', 'MCP protocol initialized');
                this.updateUI();
                
                // Send initialized notification
                const notifyRequest = {
                    jsonrpc: '2.0',
                    method: 'notifications/initialized'
                };
                await this.sendMCPMessage(notifyRequest, false);
            }
            
        } catch (error) {
            this.log('error', `MCP initialization failed: ${error.message}`);
        }
    }

    /**
     * Get available tools
     */
    async getTools() {
        if (!this.mcpInitialized) {
            this.log('error', 'MCP must be initialized before getting tools');
            return;
        }

        try {
            this.log('info', 'Fetching available tools...');
            
            const toolsRequest = {
                jsonrpc: '2.0',
                id: this.messageId++,
                method: 'tools/list'
            };

            const response = await this.sendMCPMessage(toolsRequest);
            
            if (response.result && response.result.tools) {
                this.tools = response.result.tools;
                this.log('success', `Loaded ${this.tools.length} tools`);
                this.renderTools();
            }
            
        } catch (error) {
            this.log('error', `Failed to get tools: ${error.message}`);
        }
    }

    /**
     * Send MCP message over SSE
     */
    async sendMCPMessage(message, expectResponse = true) {
        return new Promise(async (resolve, reject) => {
            if (expectResponse) {
                this.pendingRequests.set(message.id, resolve);
            }

            try {
                // Send via HTTP POST to /message endpoint
                const response = await fetch(`${this.mcpServerUrl}/message`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.accessToken}`
                    },
                    body: JSON.stringify(message)
                });

                if (!expectResponse) {
                    resolve();
                    return;
                }

                if (!response.ok) {
                    reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
                    return;
                }

                const result = await response.json();
                resolve(result);

            } catch (error) {
                if (expectResponse && message.id) {
                    this.pendingRequests.delete(message.id);
                }
                reject(error);
            }
        });
    }

    /**
     * Call a tool
     */
    async callTool(toolName, args = {}) {
        if (!this.mcpInitialized) {
            this.log('error', 'MCP must be initialized before calling tools');
            return;
        }

        try {
            this.log('info', `Calling tool: ${toolName}`);
            
            const toolRequest = {
                jsonrpc: '2.0',
                id: this.messageId++,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: args
                }
            };

            const response = await this.sendMCPMessage(toolRequest);
            
            if (response.result) {
                this.log('success', `Tool ${toolName} executed successfully`);
                this.showResponse(response.result);
                return response.result;
            } else if (response.error) {
                this.log('error', `Tool error: ${response.error.message}`);
                this.showResponse(response.error);
            }
            
        } catch (error) {
            this.log('error', `Tool call failed: ${error.message}`);
        }
    }

    /**
     * Render tools in the UI
     */
    renderTools() {
        const toolsGrid = document.getElementById('toolsGrid');
        
        if (this.tools.length === 0) {
            toolsGrid.innerHTML = `
                <div class="tool-card">
                    <h4>No tools available</h4>
                    <p>The MCP server doesn't provide any tools</p>
                </div>
            `;
            return;
        }

        toolsGrid.innerHTML = this.tools.map(tool => `
            <div class="tool-card">
                <h4>${tool.name}</h4>
                <p>${tool.description || 'No description available'}</p>
                <button class="btn btn-primary" onclick="mcpClient.callTool('${tool.name}')">
                    Execute
                </button>
            </div>
        `).join('');
    }

    /**
     * Show response in UI
     */
    showResponse(response) {
        const responseSection = document.getElementById('responseSection');
        const responseContent = document.getElementById('responseContent');
        
        responseContent.textContent = JSON.stringify(response, null, 2);
        responseSection.style.display = 'block';
        
        // Scroll to response
        responseSection.scrollIntoView({ behavior: 'smooth' });
    }

    /**
     * Update UI based on current state
     */
    updateUI() {
        // OAuth status
        const oauthStatus = document.getElementById('oauthStatus');
        const oauthIndicator = document.getElementById('oauthIndicator');
        const oauthStatusText = document.getElementById('oauthStatusText');
        const authBtn = document.getElementById('authBtn');
        const logoutBtn = document.getElementById('logoutBtn');

        if (this.accessToken) {
            oauthStatus.className = 'status-card connected';
            oauthIndicator.className = 'status-indicator connected';
            oauthStatusText.textContent = 'Authenticated';
            authBtn.style.display = 'none';
            logoutBtn.style.display = 'inline-block';
        } else {
            oauthStatus.className = 'status-card';
            oauthIndicator.className = 'status-indicator';
            oauthStatusText.textContent = 'Not authenticated';
            authBtn.style.display = 'inline-block';
            logoutBtn.style.display = 'none';
        }

        // SSE status
        const sseStatus = document.getElementById('sseStatus');
        const sseIndicator = document.getElementById('sseIndicator');
        const sseStatusText = document.getElementById('sseStatusText');
        const connectBtn = document.getElementById('connectBtn');
        const disconnectBtn = document.getElementById('disconnectBtn');

        if (this.sseConnection && this.sseConnection.readyState === EventSource.OPEN) {
            sseStatus.className = 'status-card connected';
            sseIndicator.className = 'status-indicator connected';
            sseStatusText.textContent = 'Connected';
            connectBtn.style.display = 'none';
            disconnectBtn.style.display = 'inline-block';
        } else {
            sseStatus.className = 'status-card';
            sseIndicator.className = 'status-indicator';
            sseStatusText.textContent = 'Disconnected';
            connectBtn.style.display = 'inline-block';
            disconnectBtn.style.display = 'none';
        }

        // MCP status
        const mcpStatus = document.getElementById('mcpStatus');
        const mcpIndicator = document.getElementById('mcpIndicator');
        const mcpStatusText = document.getElementById('mcpStatusText');
        const initBtn = document.getElementById('initBtn');
        const toolsBtn = document.getElementById('toolsBtn');

        if (this.mcpInitialized) {
            mcpStatus.className = 'status-card connected';
            mcpIndicator.className = 'status-indicator connected';
            mcpStatusText.textContent = 'Initialized';
            initBtn.style.display = 'none';
            toolsBtn.style.display = 'inline-block';
        } else {
            mcpStatus.className = 'status-card';
            mcpIndicator.className = 'status-indicator';
            mcpStatusText.textContent = 'Not initialized';
            initBtn.style.display = 'inline-block';
            toolsBtn.style.display = 'none';
        }
    }

    /**
     * Log message to console and UI
     */
    log(level, message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
        
        const logContainer = document.getElementById('logContainer');
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.innerHTML = `
            <span class="log-timestamp">[${new Date().toLocaleTimeString()}]</span>
            <span class="log-level-${level}">${message}</span>
        `;
        
        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }
}

// Global functions for button handlers
function updateConfiguration() {
    mcpClient.updateConfiguration();
}

function testConnectivity() {
    mcpClient.testConnectivity();
}

function authenticateOAuth() {
    mcpClient.authenticateOAuth();
}

function logout() {
    mcpClient.logout();
}

function connectSSE() {
    mcpClient.connectSSE();
}

function disconnectSSE() {
    mcpClient.disconnectSSE();
}

function initializeMCP() {
    mcpClient.initializeMCP();
}

function getTools() {
    mcpClient.getTools();
}

// Initialize client
const mcpClient = new MCPWebClient();

// Handle OAuth callback if present
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('code') || urlParams.has('error')) {
        mcpClient.handleOAuthCallback();
    }
});