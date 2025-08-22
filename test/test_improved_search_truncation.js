// Test script to verify improved search result truncation
import { handleSearchCode } from '../dist/handlers/edit-search-handlers.js';

async function testImprovedSearchTruncation() {
    try {
        console.log('Testing improved search result truncation...');
        
        // Test search that will produce many results to trigger truncation
        const searchArgs = {
            path: '.',
            pattern: '.',  // Match almost every line - this should be a lot of results
            maxResults: 50000,  // Very high limit to get lots of results, but capped at 5000
            ignoreCase: true
        };
        
        console.log('Searching for "." to get maximum results...');
        const start = Date.now();
        const result = await handleSearchCode(searchArgs);
        const end = Date.now();
        
        console.log(`Search completed in ${end - start}ms`);
        console.log('Result type:', typeof result.content[0].text);
        console.log('Result length:', result.content[0].text.length);
        
        // Check if we're within the safe limits
        if (result.content[0].text.length > 1000000) {
            console.log('❌ Results still too large - exceeds 1MB');
        } else if (result.content[0].text.length > 900000) {
            console.log('⚠️  Results close to limit but acceptable');
        } else {
            console.log('✅ Results well within safe limits');
        }
        
        if (result.content[0].text.includes('Results truncated')) {
            console.log('✅ Results properly truncated with warning message');
            const truncationIndex = result.content[0].text.indexOf('Results truncated');
            console.log('Truncation message:', result.content[0].text.substring(truncationIndex, truncationIndex + 150));
        } else {
            console.log('ℹ️  Results complete, no truncation needed');
        }
        
        console.log('First 200 characters of result:');
        console.log(result.content[0].text.substring(0, 200));
        
        // Check character length safety
        const charCount = result.content[0].text.length;
        const apiLimit = 1048576; // 1MB API limit
        const safetyMargin = apiLimit - charCount;
        console.log(`\n📊 Safety Analysis:`);
        console.log(`   Response size: ${charCount.toLocaleString()} characters`);
        console.log(`   API limit: ${apiLimit.toLocaleString()} characters`);
        console.log(`   Safety margin: ${safetyMargin.toLocaleString()} characters`);
        console.log(`   Utilization: ${((charCount / apiLimit) * 100).toFixed(1)}%`);
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testImprovedSearchTruncation().catch(console.error);
