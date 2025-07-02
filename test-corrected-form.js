#!/usr/bin/env node

/**
 * Generate CORRECTED test URLs that match the actual Tally.so form fields
 */

import { giveFeedbackToDesktopCommander } from './dist/tools/feedback.js';

async function generateCorrectedTestUrls() {
    console.log('🔗 **CORRECTED Tally.so Form Test URLs**\n');
    console.log('✅ **Field Mapping Fixed:**');
    console.log('   - what_doing → "What are you creating/building with DC?"');
    console.log('   - what_enjoy → "What do you enjoy the most about our product?"');
    console.log('   - how_better → "How can we make our product better for you?"');
    console.log('   - else_to_share → "Anything else you\'d like to share with our team?"');
    console.log('   - other_tools → "What other AI tools you use or used before?"');
    console.log('   - tool_call_count → "Tool calls count" (fixed spelling)');
    console.log('   - days_using → "Days using Desktop Commander" (restored)');
    console.log('');
    
    try {
        // Test with comprehensive data using correct field names
        console.log('📝 **Full Test with Correct Field Mapping**');
        const result = await giveFeedbackToDesktopCommander({
            email: 'test.user@company.com',
            role: 'Senior Data Scientist',
            company: 'AI Research Lab',
            heard_about: 'Reddit',
            client_used: 'Claude Desktop with VS Code',
            other_tools: 'ChatGPT, Claude Code, Windsurf, Cursor, Copilot',
            what_doing: 'Building ML data pipelines and automating research workflows',
            what_enjoy: 'The seamless Python integration and terminal access',
            how_better: 'Better support for R and Julia, more visualization tools',
            else_to_share: 'Love the tool! Would appreciate more documentation and examples',
            recommendation_score: 9,
            user_study: true
        });
        
        const url = extractUrl(result.content[0]?.text);
        console.log(`URL: ${url}\n`);
        
        // Break down the URL parameters for clarity
        console.log('📋 **URL Parameters Breakdown:**');
        const urlObj = new URL(url);
        const params = urlObj.searchParams;
        
        console.log('**User-provided fields:**');
        console.log(`   email: ${params.get('email')}`);
        console.log(`   role: ${params.get('role')}`);
        console.log(`   company: ${params.get('company')}`);
        console.log(`   heard_about: ${params.get('heard_about')}`);
        console.log(`   client_used: ${params.get('client_used')}`);
        console.log(`   other_tools: ${params.get('other_tools')}`);
        console.log(`   what_doing: ${params.get('what_doing')}`);
        console.log(`   what_enjoy: ${params.get('what_enjoy')}`);
        console.log(`   how_better: ${params.get('how_better')}`);
        console.log(`   else_to_share: ${params.get('else_to_share')}`);
        console.log(`   recommendation_score: ${params.get('recommendation_score')}`);
        console.log(`   user_study: ${params.get('user_study')}`);
        
        console.log('\n**Auto-filled fields:**');
        console.log(`   tool_call_count: ${params.get('tool_call_count')}`);
        console.log(`   days_using: ${params.get('days_using')}`);
        console.log(`   platform: ${params.get('platform')}`);
        
        console.log('\n🧪 **Testing Instructions:**');
        console.log('   1. Copy the URL above');
        console.log('   2. Paste in browser');
        console.log('   3. Check that ALL form fields are pre-filled');
        console.log('   4. Verify these specific mappings:');
        console.log('      - "What are you creating/building" has the what_doing value');
        console.log('      - "What do you enjoy most" has the what_enjoy value');
        console.log('      - "How can we make better" has the how_better value');
        console.log('      - "Anything else to share" has the else_to_share value');
        console.log('      - "Other AI tools" has the other_tools value');
        console.log('      - Rating shows the recommendation_score');
        console.log('      - User study shows the selection');
        console.log('   5. Submit to test the complete flow');
        
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
generateCorrectedTestUrls();
