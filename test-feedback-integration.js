#!/usr/bin/env node

/**
 * Test script for feedback integration
 * Tests the feedback prompt system at 3000+ tool calls
 */

import { usageTracker } from './dist/utils/usageTracker.js';

async function testFeedbackIntegration() {
    console.log('🧪 Testing Feedback Integration...\n');

    try {
        // Get current stats
        const currentStats = await usageTracker.getStats();
        console.log('📊 Current Stats:');
        console.log(`   Total Tool Calls: ${currentStats.totalToolCalls}`);
        console.log(`   Feedback Given: ${currentStats.feedbackGiven}`);
        console.log(`   Last Feedback Prompt: ${new Date(currentStats.lastFeedbackPrompt).toISOString()}`);
        console.log('');

        // Test 1: Check if should prompt (current state)
        const shouldPromptNow = await usageTracker.shouldPromptForFeedback();
        console.log(`✅ Should prompt now: ${shouldPromptNow}`);

        // Test 2: Get feedback message
        if (shouldPromptNow) {
            const message = await usageTracker.getFeedbackPromptMessage();
            console.log('📝 Feedback Message:');
            console.log(`   ${message}`);
            console.log('');
        }

        // Test 3: Test with 3000+ calls (temporary modification)
        console.log('🔧 Testing with 3000+ calls scenario...');
        
        // Backup current stats
        const backup = { ...currentStats };
        
        // Temporarily set high usage
        const testStats = { 
            ...currentStats, 
            totalToolCalls: 3500,
            feedbackGiven: false,
            lastFeedbackPrompt: 0 
        };
        await usageTracker.saveStats(testStats);

        const shouldPromptTest = await usageTracker.shouldPromptForFeedback();
        console.log(`✅ Should prompt with 3500 calls: ${shouldPromptTest}`);

        if (shouldPromptTest) {
            const testMessage = await usageTracker.getFeedbackPromptMessage();
            console.log('📝 Test Feedback Message:');
            console.log(`   ${testMessage}`);
        }

        // Test 4: Test cooldown (2 hours)
        console.log('\n🕐 Testing 2-hour cooldown...');
        await usageTracker.markFeedbackPrompted(); // This sets lastFeedbackPrompt to now

        const shouldPromptAfterCooldown = await usageTracker.shouldPromptForFeedback();
        console.log(`✅ Should prompt after just being prompted: ${shouldPromptAfterCooldown}`);

        // Restore original stats
        await usageTracker.saveStats(backup);
        console.log('\n✅ Original stats restored');

        console.log('\n🎉 Feedback Integration Test Complete!');

    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testFeedbackIntegration();
