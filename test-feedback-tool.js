#!/usr/bin/env node

/**
 * Test script for feedback tool functionality
 * Tests the give_feedback_to_desktop_commander tool
 */

import { giveFeedbackToDesktopCommander } from './dist/tools/feedback.js';

async function testFeedbackTool() {
    console.log('🧪 Testing Feedback Tool...\n');

    try {
        // Test 1: Empty feedback (should still work)
        console.log('📝 Test 1: Empty feedback form...');
        const result1 = await giveFeedbackToDesktopCommander();
        console.log('Result:', result1.isError ? '❌ ERROR' : '✅ SUCCESS');
        console.log('Message preview:', result1.content[0]?.text?.substring(0, 100) + '...');
        console.log('');

        // Test 2: Partial feedback (common scenario)
        console.log('📝 Test 2: Partial feedback with email and role...');
        const result2 = await giveFeedbackToDesktopCommander({
            email: 'user@example.com',
            role: 'Developer',
            feedback_type: 'general',
            works_well: 'Great for file operations and terminal integration!'
        });
        console.log('Result:', result2.isError ? '❌ ERROR' : '✅ SUCCESS');
        console.log('Message preview:', result2.content[0]?.text?.substring(0, 100) + '...');
        console.log('');

        // Test 3: Full feedback (AI-assisted scenario)
        console.log('📝 Test 3: Full feedback form...');
        const result3 = await giveFeedbackToDesktopCommander({
            email: 'power.user@company.com',
            role: 'Data Scientist',
            company: 'TechCorp Inc',
            feedback_type: 'feature_request',
            what_building: 'ML data pipeline with automated analysis',
            works_well: 'Python integration is seamless, love the interactive sessions',
            could_improve: 'Would like better support for R and Julia',
            recommendation_score: 9
        });
        console.log('Result:', result3.isError ? '❌ ERROR' : '✅ SUCCESS');
        console.log('Message preview:', result3.content[0]?.text?.substring(0, 100) + '...');
        console.log('');

        // Test 4: Check URL generation (extract from one of the results)
        if (!result1.isError && result1.content[0]?.text) {
            const urlMatch = result1.content[0].text.match(/https:\/\/tally\.so\/[^\s)]+/);
            if (urlMatch) {
                console.log('🔗 Generated URL sample:');
                console.log(urlMatch[0]);
                console.log('');
            }
        }

        console.log('🎉 Feedback Tool Test Complete!');
        console.log('');
        console.log('💡 Next steps:');
        console.log('   1. Create the actual Tally.so form at: https://tally.so/r/desktop-commander-feedback');
        console.log('   2. Configure form fields to match the URL parameters');
        console.log('   3. Test with real browser opening');

    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
testFeedbackTool();
