// Test script to verify search result truncation
import { handleSearchCode } from '../dist/handlers/edit-search-handlers.js';

async function testSearchTruncation() {
    try {
        console.log('Testing search result truncation...');
        
        // Test search that will produce many results
        const searchArgs = {
            path: '.',
            pattern: 'function|const|let|var',  // This should match many lines
            maxResults: 50000,  // Very high limit to get lots of results
            ignoreCase: true
        };
        
        console.log('Searching for common JavaScript patterns...');
        const result = await handleSearchCode(searchArgs);
        
        console.log('Result type:', typeof result.content[0].text);
        console.log('Result length:', result.content[0].text.length);
        
        if (result.content[0].text.length > 1000000) {
            console.log('❌ Results not truncated - this would exceed Claude limits');
        } else if (result.content[0].text.includes('Results truncated')) {
            console.log('✅ Results properly truncated with warning message');
            const truncationIndex = result.content[0].text.indexOf('Results truncated');
            console.log('Truncation message:', result.content[0].text.substring(truncationIndex, truncationIndex + 100));
        } else {
            console.log('✅ Results under limit, no truncation needed');
        }
        
        console.log('First 200 characters of result:');
        console.log(result.content[0].text.substring(0, 200));
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testSearchTruncation().catch(console.error);
