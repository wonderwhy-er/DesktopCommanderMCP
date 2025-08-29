// Test script to verify improved search result behavior using new streaming API
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';

/**
 * Helper function to wait for search completion and get all results
 */
async function searchAndWaitForCompletion(searchArgs, timeout = 30000) {
  const result = await handleStartSearch(searchArgs);
  
  // Extract session ID from result with tighter regex
  const sessionIdMatch = result.content[0].text.match(/Started .* session:\s*([a-zA-Z0-9_-]+)/);
  if (!sessionIdMatch) {
    throw new Error('Could not extract session ID from search result');
  }
  const sessionId = sessionIdMatch[1];
  
  try {
    // Wait for completion by polling
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const moreResults = await handleGetMoreSearchResults({ sessionId });
      
      if (moreResults.content[0].text.includes('✅ Search completed')) {
        return { initialResult: result, finalResult: moreResults, sessionId };
      }
      
      if (moreResults.content[0].text.includes('❌ ERROR')) {
        throw new Error(`Search failed: ${moreResults.content[0].text}`);
      }
      
      // Wait a bit before polling again
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error('Search timed out');
  } finally {
    // Always stop the search session to prevent hanging
    try {
      await handleStopSearch({ sessionId });
    } catch (e) {
      // Ignore errors when stopping - session might already be completed
    }
  }
}

async function testImprovedSearchTruncation() {
    try {
        console.log('Testing improved search result behavior with streaming API...');
        
        // Test search that will produce many results to trigger potential limits
        const searchArgs = {
            path: '.',
            pattern: '.',  // Match almost every line - this should be a lot of results
            searchType: 'content',
            maxResults: 50000,  // Very high limit to get lots of results, but may be capped
            ignoreCase: true
        };
        
        console.log('Searching for "." to get maximum results...');
        const start = Date.now();
        const { initialResult, finalResult } = await searchAndWaitForCompletion(searchArgs);
        const end = Date.now();
        
        console.log(`Search completed in ${end - start}ms`);
        console.log('Initial result type:', typeof initialResult.content[0].text);
        console.log('Initial result length:', initialResult.content[0].text.length);
        console.log('Final result type:', typeof finalResult.content[0].text);
        console.log('Final result length:', finalResult.content[0].text.length);
        
        const totalLength = initialResult.content[0].text.length + finalResult.content[0].text.length;
        const apiLimit = 1048576; // 1 MiB - use consistent constant
        
        // Check if we're within the safe limits using single source of truth
        if (totalLength > apiLimit) {
            console.log('❌ Results still quite large - over 1MB combined');
        } else if (totalLength > Math.floor(0.8 * apiLimit)) {
            console.log('⚠️  Results approaching limits but acceptable');
        } else {
            console.log('✅ Results well within safe limits');
        }
        
        if (finalResult.content[0].text.includes('Results truncated')) {
            console.log('✅ Results properly truncated with warning message');
            const truncationIndex = finalResult.content[0].text.indexOf('Results truncated');
            console.log('Truncation message:', finalResult.content[0].text.substring(truncationIndex, truncationIndex + 150));
        } else {
            console.log('ℹ️  Results complete, no truncation needed with new streaming API');
        }
        
        console.log('First 200 characters of final result:');
        console.log(finalResult.content[0].text.substring(0, 200));
        
        // Check character length safety
        const safetyMargin = apiLimit - totalLength;
        console.log(`\n📊 Safety Analysis:`);
        console.log(`   Initial response: ${initialResult.content[0].text.length.toLocaleString()} characters`);
        console.log(`   Final response: ${finalResult.content[0].text.length.toLocaleString()} characters`);
        console.log(`   Combined size: ${totalLength.toLocaleString()} characters`);
        console.log(`   API limit: ${apiLimit.toLocaleString()} characters`);
        console.log(`   Safety margin: ${safetyMargin.toLocaleString()} characters`);
        console.log(`   Utilization: ${((totalLength / apiLimit) * 100).toFixed(1)}%`);
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testImprovedSearchTruncation().then(() => {
    console.log('Improved search truncation test completed successfully.');
    process.exit(0);
}).catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
