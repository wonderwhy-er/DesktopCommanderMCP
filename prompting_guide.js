/**
 * PROPER PROMPTING STRATEGY FOR TOOLS
 * Based on actual server.ts capabilities
 */

// ✅ WHEN TO USE TERMINAL REPL (execute_command + send_input + read_output)
// - File access + interactive coding needed
// - Complex data analysis with file reading
// - Multi-step explorations
// - When you need both file system AND computation

// Example prompts that trigger terminal REPL:
// "Start Python REPL and analyze the CSV file"
// "Use Node.js to interactively explore the file structure" 
// "Launch Python to process the large dataset"
// "Start interactive Python session to calculate statistics from the file"

// ✅ WHEN TO USE ANALYSIS TOOL (repl function)
// - Pure mathematical calculations (no file access)
// - Data transformations on provided data
// - Complex algorithms that don't need files
// - Prototyping visualizations for artifacts

// Example prompts that trigger analysis tool:
// "Calculate the compound interest formula"
// "Analyze this dataset: [provided data]"
// "Process this JSON structure and find patterns"
// "Create statistical analysis of these numbers"

// ❌ ANTI-PATTERNS TO AVOID:
// "Use analysis tool to read the CSV file" - Won't work!
// "Use repl to access file system" - Can't do it!

// 🎯 OPTIMAL PROMPTING EXAMPLES:

// For file + analysis:
"Start a Python REPL, read the CSV file, and perform statistical analysis"

// For pure math:
"Use analysis to calculate the complex statistical formulas"

// For exploration:
"Launch interactive Python session to explore the unknown file structure"

// For prototyping:
"Use analysis to prototype the chart data transformation logic"
