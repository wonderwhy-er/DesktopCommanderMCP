#!/usr/bin/env node

/**
 * Test script for 3000+ engagement trigger
 */

import { usageTracker } from './dist/utils/usageTracker.js';
import { configManager } from './dist/config-manager.js';

async function testEngagementTrigger() {
    console.log('🧪 Testing 3000+ Engagement Trigger\n');
    
    try {
        // Initialize config manager
        await configManager.init();
        console.log('✅ Config manager initialized');
        
        // Clear existing stats for clean test
        await configManager.setValue('usageStats', null);
        console.log('✅ Cleared existing stats');
        
        // Simulate 3000+ tool calls
        console.log('⚡ Simulating 3000+ tool calls (this might take a moment)...');
        
        const stats = await usageTracker.getStats();
        
        // Manually set to just over 3000 to trigger
        stats.totalToolCalls = 3001;
        stats.successfulCalls = 2950;
        stats.failedCalls = 51;
        stats.feedbackGiven = false;
        stats.lastFeedbackPrompt = 0;
        
        // Add some realistic usage patterns
        stats.toolCounts = {
            'read_file': 800,
            'write_file': 650,
            'execute_command': 500,
            'edit_block': 400,
            'search_code': 300,
            'list_directory': 250,
            'search_files': 101
        };
        
        stats.filesystemOperations = 1700;
        stats.terminalOperations = 500;
        stats.editOperations = 400;
        stats.searchOperations = 401;
        
        await configManager.setValue('usageStats', stats);
        console.log('✅ Set usage to 3001 total calls');
        
        // Test if feedback should be prompted
        const shouldPrompt = await usageTracker.shouldPromptForFeedback();
        console.log(`\n🎯 Should prompt for feedback: ${shouldPrompt}`);
        
        if (shouldPrompt) {
            console.log('\n📝 Testing random feedback messages:');
            
            // Show 5 different random messages
            for (let i = 0; i < 5; i++) {
                const message = await usageTracker.getFeedbackPromptMessage();
                console.log(`\n${i + 1}. ${message}`);
            }
            
            // Mark as prompted and test again
            await usageTracker.markFeedbackPrompted();
            const shouldPromptAgain = await usageTracker.shouldPromptForFeedback();
            console.log(`\n🔄 Should prompt again after marking: ${shouldPromptAgain}`);
        }
        
        // Show final stats
        console.log('\n📊 Final Usage Summary:');
        const summary = await usageTracker.getUsageSummary();
        console.log(summary);
        
        console.log('\n🎉 Engagement trigger test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testEngagementTrigger().catch(console.error);
