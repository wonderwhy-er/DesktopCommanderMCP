#!/usr/bin/env node

/**
 * Test the get_usage_stats tool specifically
 */

import { getUsageStats } from './dist/tools/usage.js';

async function testGetUsageStatsEndpoint() {
    console.log('🧪 Testing get_usage_stats tool endpoint\n');
    
    try {
        const result = await getUsageStats();
        
        console.log('✅ Tool executed successfully');
        console.log('📊 Result:');
        console.log(result);
        
        if (result.content && result.content[0] && result.content[0].text) {
            console.log('\n📈 Stats content:');
            console.log(result.content[0].text);
        }
        
        console.log('\n🎉 get_usage_stats tool test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testGetUsageStatsEndpoint().catch(console.error);
