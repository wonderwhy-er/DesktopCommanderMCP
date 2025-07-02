#!/usr/bin/env node

/**
 * Generate test URLs for the Tally.so feedback form
 */

import { giveFeedbackToDesktopCommander } from './dist/tools/feedback.js';

async function generateTestUrls() {
    console.log('🔗 **Tally.so Form Test URLs**\n');
    
    try {
        // Test 1: Basic form (empty parameters)
        console.log('📝 **Test 1: Basic Form**');
        const result1 = await giveFeedbackToDesktopCommander({});
        const url1 = extractUrl(result1.content[0]?.text);
        console.log(`URL: ${url1}\n`);

        // Test 2: Partial data (common use case)
        console.log('📝 **Test 2: Developer Feedback**');
        const result2 = await giveFeedbackToDesktopCommander({
            email: 'john.developer@company.com',
            role: 'Developer',
            company: 'TechCorp Inc',
            heard_about: 'GitHub',
            client_used: 'Claude Desktop',
            what_doing: 'Building ML data pipelines',
            works_well: 'Python integration is seamless',
            could_improve: 'Better R and Julia support',
            recommendation_score: 9,
            user_study: true
        });
        const url2 = extractUrl(result2.content[0]?.text);
        console.log(`URL: ${url2}\n`);

        // Test 3: Data scientist profile
        console.log('📝 **Test 3: Data Scientist Profile**');
        const result3 = await giveFeedbackToDesktopCommander({
            email: 'sarah.data@research.edu',
            role: 'Data Scientist',
            company: 'Research University',
            heard_about: 'Reddit',
            client_used: 'VS Code',
            what_doing: 'Analyzing research datasets',
            works_well: 'CSV processing and terminal integration',
            could_improve: 'Better visualization tools',
            recommendation_score: 8,
            user_study: false
        });
        const url3 = extractUrl(result3.content[0]?.text);
        console.log(`URL: ${url3}\n`);

        // Test 4: Student user
        console.log('📝 **Test 4: Student User**');
        const result4 = await giveFeedbackToDesktopCommander({
            email: 'student@university.edu',
            role: 'Student',
            heard_about: 'YouTube',
            client_used: 'Claude Desktop',
            what_doing: 'Learning data analysis',
            works_well: 'Easy to get started',
            could_improve: 'More tutorials and examples',
            recommendation_score: 7,
            user_study: true
        });
        const url4 = extractUrl(result4.content[0]?.text);
        console.log(`URL: ${url4}\n`);

        console.log('✅ **All test URLs generated successfully!**');
        console.log('\n💡 **How to test:**');
        console.log('   1. Copy any URL above');
        console.log('   2. Paste in browser');
        console.log('   3. Check that form fields are pre-filled');
        console.log('   4. Verify all data appears correctly');
        console.log('   5. Test form submission');
        
    } catch (error) {
        console.error('❌ Error generating test URLs:', error);
    }
}

function extractUrl(text) {
    if (!text) return 'No URL found';
    const match = text.match(/https:\/\/tally\.so\/[^\s)]+/);
    return match ? match[0] : 'No URL found';
}

// Run the test
generateTestUrls();
