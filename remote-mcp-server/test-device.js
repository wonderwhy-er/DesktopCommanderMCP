const WebSocket = require('ws');

// Replace with actual device token from the dashboard
const deviceToken = process.argv[2];

if (!deviceToken) {
    console.error('Usage: node test-device.js <DEVICE_TOKEN>');
    console.error('Get the device token from the dashboard after registering a device');
    process.exit(1);
}

console.log('Connecting to Remote MCP Server...');
const ws = new WebSocket('ws://localhost:3002/ws');

ws.on('open', () => {
    console.log('✅ Connected to Remote MCP Server');
    
    // Send authentication
    ws.send(JSON.stringify({
        id: 'auth-1',
        type: 'auth',
        payload: { deviceToken },
        timestamp: Date.now()
    }));
});

ws.on('message', (data) => {
    try {
        const message = JSON.parse(data);
        console.log('📨 Received:', message.type, message.payload?.message || '');
        
        if (message.type === 'auth' && message.payload?.success) {
            console.log(`🎉 Authentication successful! Device ID: ${message.payload.deviceId}`);
        }
        
        if (message.type === 'mcp_request') {
            console.log('🔧 Executing MCP request:', message.payload.method);
            console.log('   Params:', JSON.stringify(message.payload.params, null, 2));
            
            // Mock response for different MCP methods
            let mockResult;
            
            switch (message.payload.method) {
                case 'read_file':
                    mockResult = {
                        content: `Mock file content for ${message.payload.params?.path}\nLine 1: Hello from Remote MCP!\nLine 2: This is a test file\nLine 3: Generated at ${new Date().toISOString()}`,
                        metadata: {
                            size: 123,
                            lastModified: new Date().toISOString()
                        }
                    };
                    break;
                    
                case 'list_directory':
                    mockResult = {
                        files: [
                            { name: 'document.txt', type: 'file', size: 1024 },
                            { name: 'images', type: 'directory' },
                            { name: 'script.py', type: 'file', size: 2048 }
                        ],
                        path: message.payload.params?.path
                    };
                    break;
                    
                case 'get_file_info':
                    mockResult = {
                        name: message.payload.params?.path?.split('/').pop(),
                        path: message.payload.params?.path,
                        size: 2048,
                        type: 'file',
                        lastModified: new Date().toISOString(),
                        permissions: 'rw-r--r--'
                    };
                    break;
                    
                case 'start_process':
                    mockResult = {
                        pid: 12345,
                        command: message.payload.params?.command,
                        output: `Executing: ${message.payload.params?.command}\nMock process output\nCompleted successfully!`,
                        exitCode: 0,
                        executionTime: 150
                    };
                    break;
                    
                default:
                    mockResult = {
                        method: message.payload.method,
                        message: 'Mock response from Remote MCP device',
                        timestamp: new Date().toISOString(),
                        params: message.payload.params
                    };
            }
            
            // Send response back to server
            const response = {
                id: message.id,
                type: 'mcp_response',
                payload: {
                    jsonrpc: '2.0',
                    id: message.payload.id,
                    result: mockResult
                },
                timestamp: Date.now()
            };
            
            console.log('📤 Sending response:', message.payload.method, 'completed');
            ws.send(JSON.stringify(response));
        }
        
        if (message.type === 'heartbeat') {
            // Respond to heartbeat
            ws.send(JSON.stringify({
                id: message.id,
                type: 'heartbeat',
                payload: { timestamp: Date.now() },
                timestamp: Date.now()
            }));
        }
        
    } catch (error) {
        console.error('❌ Error processing message:', error);
    }
});

ws.on('close', (code, reason) => {
    console.log(`🔌 Disconnected (${code}): ${reason}`);
});

ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
});

// Send periodic heartbeat
setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            id: `heartbeat-${Date.now()}`,
            type: 'heartbeat',
            payload: { timestamp: Date.now() },
            timestamp: Date.now()
        }));
    }
}, 30000); // Every 30 seconds

console.log('📱 Test device client started');
console.log('🔑 Using device token:', deviceToken.substring(0, 20) + '...');
console.log('💡 Tip: Register a device in the dashboard first, then copy the token here');