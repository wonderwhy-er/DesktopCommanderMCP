#!/usr/bin/env node

/**
 * Test script for usage tracking functionality
 */

import { usageTracker } from './dist/utils/usageTracker.js';
import { configManager } from './dist/config-manager.js';

async function testUsageTracking() {
    console.log('🧪 Testing Usage Tracking System\n');
    
    try {
        // Initialize config manager
        await configManager.init();
        console.log('✅ Config manager initialized');
        
        // Clear existing stats for clean test
        await configManager.setValue('usageStats', null);
        console.log('✅ Cleared existing stats');
        
        // Test tracking some tool calls
        console.log('\n📊 Simulating tool usage...');
        
        // Simulate some filesystem operations
        await usageTracker.trackSuccess('read_file');
        await usageTracker.trackSuccess('write_file');
        await usageTracker.trackSuccess('list_directory');
        
        // Simulate some terminal operations
        await usageTracker.trackSuccess('execute_command');
        await usageTracker.trackFailure('execute_command'); // One failure
        
        // Simulate some editing
        await usageTracker.trackSuccess('edit_block');
        await usageTracker.trackSuccess('edit_block');
        
        // Simulate search operations
        await usageTracker.trackSuccess('search_code');
        await usageTracker.trackSuccess('search_files');
        
        console.log('✅ Simulated 9 tool calls (8 success, 1 failure)');
        
        // Get and display stats
        console.log('\n📈 Current Usage Stats:');
        const summary = await usageTracker.getUsageSummary();
        console.log(summary);
        
        // Test feedback prompting logic
        console.log('\n🔄 Testing feedback prompts...');
        const shouldPromptSuccess = await usageTracker.shouldPromptForFeedback();
        const shouldPromptError = await usageTracker.shouldPromptForErrorFeedback();
        
        console.log(`Should prompt for success feedback: ${shouldPromptSuccess}`);
        console.log(`Should prompt for error feedback: ${shouldPromptError}`);
        
        // Simulate more usage to trigger feedback prompt
        console.log('\n⚡ Simulating more usage to test thresholds...');
        
        // Add more successful calls to reach threshold (15 total)
        for (let i = 0; i < 7; i++) {
            await usageTracker.trackSuccess('read_file');
        }
        
        // Make sure we've been "using" for more than 2 days by adjusting first used timestamp
        const stats = await usageTracker.getStats();
        stats.firstUsed = Date.now() - (3 * 24 * 60 * 60 * 1000); // 3 days ago
        await configManager.setValue('usageStats', stats);
        
        // Check again
        const shouldPromptNow = await usageTracker.shouldPromptForFeedback();
        console.log(`Should prompt for feedback now: ${shouldPromptNow}`);
        
        // Final summary
        console.log('\n📊 Final Usage Summary:');
        const finalSummary = await usageTracker.getUsageSummary();
        console.log(finalSummary);
        
        console.log('\n🎉 Usage tracking test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testUsageTracking().catch(console.error);
