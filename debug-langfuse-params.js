/**
 * Debug script to test the LangfuseTestParams functionality
 * 
 * To test:
 * 1. Add URL parameters: ?dataset_id=test-dataset&test_run_id=test-run&dataset_item_id=test-item
 * 2. Run this in browser console or include in your testing
 */

// Debug function to check what's happening with LangfuseTestParams
function debugLangfuseParams() {
    console.log("=== LANGFUSE PARAMS DEBUG ===");
    
    // Check URL parameters directly
    const url = new URL(window.location.href);
    console.log("Current URL:", window.location.href);
    console.log("URL Parameters:");
    console.log("  dataset_id:", url.searchParams.get("dataset_id"));
    console.log("  test_run_id:", url.searchParams.get("test_run_id"));
    console.log("  dataset_item_id:", url.searchParams.get("dataset_item_id"));
    
    // Check if LangfuseTestParams is available and initialized
    try {
        // Try to access the module (this might vary depending on how modules are exposed)
        if (window.require) {
            window.require(["prezi_open_ai_utils"], (openAiUtils) => {
                console.log("OpenAI Utils module loaded:", !!openAiUtils);
                
                if (openAiUtils && openAiUtils.LangfuseTestParams) {
                    console.log("LangfuseTestParams available:", !!openAiUtils.LangfuseTestParams);
                    
                    // Check if getParams method exists and what it returns
                    if (openAiUtils.LangfuseTestParams.getParams) {
                        const params = openAiUtils.LangfuseTestParams.getParams();
                        console.log("LangfuseTestParams.getParams():", params);
                        
                        // Check if hasParameters method exists
                        if (openAiUtils.LangfuseTestParams.hasParameters) {
                            console.log("LangfuseTestParams.hasParameters():", openAiUtils.LangfuseTestParams.hasParameters());
                        }
                    } else {
                        console.log("getParams method not found");
                    }
                } else {
                    console.log("LangfuseTestParams not found in module");
                }
            });
        } else {
            console.log("window.require not available");
        }
    } catch (error) {
        console.error("Error accessing LangfuseTestParams:", error);
    }
    
    // Check feature flags
    try {
        if (window.require) {
            window.require(["prezi_featureswitcher"], (featureSwitcher) => {
                if (featureSwitcher && featureSwitcher.isActive) {
                    console.log("js-langfuse-tracing enabled:", featureSwitcher.isActive("js-langfuse-tracing"));
                    console.log("js-use-langfuse enabled:", featureSwitcher.isActive("js-use-langfuse"));
                }
            });
        }
    } catch (error) {
        console.error("Error checking feature flags:", error);
    }
    
    console.log("=== END DEBUG ===");
}

// For use in browser console
if (typeof window !== 'undefined') {
    window.debugLangfuseParams = debugLangfuseParams;
    console.log("Debug function available as window.debugLangfuseParams()");
    console.log("To test: Add URL params ?dataset_id=test-dataset&test_run_id=test-run&dataset_item_id=test-item and call debugLangfuseParams()");
}

// For Node.js testing
if (typeof module !== 'undefined') {
    module.exports = { debugLangfuseParams };
}
