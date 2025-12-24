#!/usr/bin/env node

const fetch = require('cross-fetch');

// Helper script to get a device token programmatically
class TokenHelper {
  constructor(serverUrl = 'http://localhost:3002') {
    this.serverUrl = serverUrl;
  }

  async getDeviceToken(email = 'test@example.com', name = 'Test User', deviceName = 'My Computer') {
    try {
      console.log('🔑 Getting device token from Remote MCP Server...');
      console.log(`📧 Email: ${email}`);
      console.log(`👤 Name: ${name}`);
      console.log(`💻 Device: ${deviceName}`);
      
      // Step 1: Login/Create user
      console.log('\n📝 Step 1: Creating user account...');
      const loginResponse = await fetch(`${this.serverUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
      });

      if (!loginResponse.ok) {
        throw new Error(`Login failed: ${loginResponse.status} ${await loginResponse.text()}`);
      }

      const loginData = await loginResponse.json();
      console.log(`✅ User created/logged in: ${loginData.user.name} (${loginData.user.email})`);
      
      const authToken = loginData.token;
      
      // Step 2: Register device
      console.log('\n📱 Step 2: Registering device...');
      const deviceResponse = await fetch(`${this.serverUrl}/api/device/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ name: deviceName })
      });

      if (!deviceResponse.ok) {
        const errorText = await deviceResponse.text();
        throw new Error(`Device registration failed: ${deviceResponse.status} ${errorText}`);
      }

      const deviceData = await deviceResponse.json();
      console.log(`✅ Device registered: ${deviceData.device.name} (${deviceData.device.id})`);
      
      return {
        deviceToken: deviceData.deviceToken,
        deviceId: deviceData.device.id,
        userId: deviceData.device.user_id,
        deviceName: deviceData.device.name
      };

    } catch (error) {
      console.error('❌ Failed to get device token:', error.message);
      throw error;
    }
  }

  async showUsageInstructions(tokenData) {
    console.log('\n' + '='.repeat(80));
    console.log('🎉 SUCCESS! Your device token is ready to use.');
    console.log('='.repeat(80));
    
    console.log('\n📋 DEVICE INFORMATION:');
    console.log(`   Device ID: ${tokenData.deviceId}`);
    console.log(`   Device Name: ${tokenData.deviceName}`);
    console.log(`   User ID: ${tokenData.userId}`);
    
    console.log('\n🔑 YOUR DEVICE TOKEN:');
    console.log('─'.repeat(50));
    console.log(tokenData.deviceToken);
    console.log('─'.repeat(50));
    console.log('⚠️  IMPORTANT: Save this token securely - you cannot retrieve it again!');
    
    console.log('\n🚀 NEXT STEPS:');
    
    console.log('\n1️⃣ START THE LOCAL AGENT:');
    console.log('   Copy and run this command on your remote machine:');
    console.log('   ┌─────────────────────────────────────────────────────────┐');
    console.log(`   │ ./agent.js ${this.serverUrl} "${tokenData.deviceToken}" │`);
    console.log('   └─────────────────────────────────────────────────────────┘');
    
    console.log('\n2️⃣ CONNECT IN CLAUDE DESKTOP:');
    console.log('   Send this exact message to Claude:');
    console.log('   ┌─────────────────────────────────────────────────────────┐');
    console.log(`   │ Please connect to my remote MCP server using:          │`);
    console.log(`   │ - Server URL: ${this.serverUrl}                  │`);
    console.log(`   │ - Device Token: ${tokenData.deviceToken}                │`);
    console.log('   └─────────────────────────────────────────────────────────┘');
    
    console.log('\n3️⃣ TEST THE CONNECTION:');
    console.log('   Try these commands in Claude Desktop:');
    console.log('   • "Check my remote MCP connection status"');
    console.log('   • "Read the file /etc/hostname on the remote machine"');
    console.log('   • "Run the command \'uname -a\' on the remote machine"');
    
    console.log('\n🔍 VERIFY CONNECTION:');
    console.log(`   • Dashboard: ${this.serverUrl}`);
    console.log(`   • Health Check: curl ${this.serverUrl}/health`);
    console.log(`   • SSE Status: curl ${this.serverUrl}/sse/status`);
    
    console.log('\n' + '='.repeat(80));
  }
}

// CLI Usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  let serverUrl = 'http://localhost:3002';
  let email = 'test@example.com';
  let name = 'Test User';
  let deviceName = 'My Computer';
  
  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--server' || arg === '-s') {
      serverUrl = args[++i];
    } else if (arg === '--email' || arg === '-e') {
      email = args[++i];
    } else if (arg === '--name' || arg === '-n') {
      name = args[++i];
    } else if (arg === '--device' || arg === '-d') {
      deviceName = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node get-device-token.js [options]

Options:
  -s, --server <url>     Server URL (default: http://localhost:3002)
  -e, --email <email>    User email (default: test@example.com)
  -n, --name <name>      User name (default: Test User)
  -d, --device <name>    Device name (default: My Computer)
  -h, --help            Show this help message

Examples:
  node get-device-token.js
  node get-device-token.js --email john@example.com --name "John Doe"
  node get-device-token.js --device "Production Server"
  node get-device-token.js --server https://my-server.com
`);
      process.exit(0);
    }
  }

  const helper = new TokenHelper(serverUrl);
  
  helper.getDeviceToken(email, name, deviceName)
    .then(tokenData => {
      return helper.showUsageInstructions(tokenData);
    })
    .then(() => {
      console.log('✨ Token generation complete!');
    })
    .catch(error => {
      console.error('💥 Failed to generate token:', error.message);
      process.exit(1);
    });
}