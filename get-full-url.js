#!/usr/bin/env node

/**
 * Generate complete test URL without truncation
 */

import { giveFeedbackToDesktopCommander } from './dist/tools/feedback.js';

async function getFullTestUrl() {
    try {
        const result = await giveFeedbackToDesktopCommander({
            email: 'test@example.com',
            role: 'Developer',
            company: 'TechCorp',
            heard_about: 'Reddit',
            client_used: 'Claude Desktop',
            other_tools: 'ChatGPT, Cursor',
            what_doing: 'Building ML pipelines',
            what_enjoy: 'Python integration',
            how_better: 'Better R support',
            else_to_share: 'Great tool!',
            recommendation_score: 9,
            user_study: true
        });
        
        // Extract the full URL from the result
        const fullText = result.content[0]?.text || '';
        const match = fullText.match(/https:\/\/tally\.so\/[^\s)]+/);
        
        if (match) {
            const fullUrl = match[0];
            console.log('🔗 **Complete Test URL:**');
            console.log(fullUrl);
            console.log('');
            
            // Parse and display parameters
            const url = new URL(fullUrl);
            console.log('📋 **All URL Parameters:**');
            for (const [key, value] of url.searchParams) {
                console.log(`   ${key}: ${value}`);
            }
        } else {
            console.log('❌ Could not extract URL from result');
            console.log('Full response:', fullText);
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

getFullTestUrl();
