
import { z } from 'zod'; // Added for schema extension

import {
    StartProcessArgsSchema,
    ReadProcessOutputArgsSchema,
    InteractWithProcessArgsSchema,
    ForceTerminateArgsSchema,
    ListSessionsArgsSchema,
    KillProcessArgsSchema,
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    GetFileInfoArgsSchema,
    GetConfigArgsSchema,
    SetConfigValueArgsSchema,
    ListProcessesArgsSchema,
    EditBlockArgsSchema,
    GetUsageStatsArgsSchema,
    GiveFeedbackArgsSchema,
    StartSearchArgsSchema,
    GetMoreSearchResultsArgsSchema,
    StopSearchArgsSchema,
    ListSearchesArgsSchema,
    GetPromptsArgsSchema,
    GetRecentToolCallsArgsSchema,
    WritePdfArgsSchema,
} from './schemas.js';


const CMD_PREFIX_DESCRIPTION = `This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.`;

/**
 * Wraps a Zod schema to add an optional device_id parameter.
 * This allows targeting a specific remote device.
 * @param {z.ZodObject} schema - The original input schema
 * @returns {z.ZodObject} - The extended schema with device_id
 */
const withDeviceSelection = (schema) => {
    const deviceParam = {
        device_id: z.string().optional().describe("Optional: The ID of the specific device to execute this tool on. If not provided, the first available online device will be used.")
    };

    if (typeof schema.extend === 'function') {
        return schema.extend(deviceParam);
    }

    // Fallback for ZodEffects (refine) or other types that don't support extend
    return schema.and(z.object(deviceParam));
};


export const allTools = [
    // Configuration tools
    {
        name: "get_config",
        description: `
                        Get the complete server configuration as JSON. Config includes fields for:
                        - blockedCommands (array of blocked shell commands)
                        - defaultShell (shell to use for commands)
                        - allowedDirectories (paths the server can access)
                        - fileReadLineLimit (max lines for read_file, default 1000)
                        - fileWriteLineLimit (max lines per write_file call, default 50)
                        - telemetryEnabled (boolean for telemetry opt-in/out)
                        - currentClient (information about the currently connected MCP client)
                        - clientHistory (history of all clients that have connected)
                        - version (version of the DesktopCommander)
                        - systemInfo (operating system and environment details)
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(GetConfigArgsSchema),
        annotations: {
            title: "Get Configuration",
            readOnlyHint: true,
        },
    },
    {
        name: "set_config_value",
        description: `
                        Set a specific configuration value by key.
                        
                        WARNING: Should be used in a separate chat from file operations and 
                        command execution to prevent security issues.
                        
                        Config keys include:
                        - blockedCommands (array)
                        - defaultShell (string)
                        - allowedDirectories (array of paths)
                        - fileReadLineLimit (number, max lines for read_file)
                        - fileWriteLineLimit (number, max lines per write_file call)
                        - telemetryEnabled (boolean)
                        
                        IMPORTANT: Setting allowedDirectories to an empty array ([]) allows full access 
                        to the entire file system, regardless of the operating system.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(SetConfigValueArgsSchema),
        annotations: {
            title: "Set Configuration Value",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },

    // Filesystem tools
    {
        name: "read_file",
        description: `
                        Read contents from files and URLs.
                        Read PDF files and extract content as markdown and images.
                        
                        Prefer this over 'execute_command' with cat/type for viewing files.
                        
                        Supports partial file reading with:
                        - 'offset' (start line, default: 0)
                          * Positive: Start from line N (0-based indexing)
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting, initially 1000)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail lines)
                        
                        Examples:
                        - offset: 0, length: 10     → First 10 lines
                        - offset: 100, length: 5    → Lines 100-104
                        - offset: -20               → Last 20 lines  
                        - offset: -5, length: 10    → Last 5 lines (length ignored)
                        
                        Performance optimizations:
                        - Large files with negative offsets use reverse reading for efficiency
                        - Large files with deep positive offsets use byte estimation
                        - Small files use fast readline streaming
                        
                        When reading from the file system, only works within allowed directories.
                        Can fetch content from URLs when isUrl parameter is set to true
                        (URLs are always read in full regardless of offset/length).
                        
                        FORMAT HANDLING (by extension):
                        - Text: Uses offset/length for line-based pagination
                        - Excel (.xlsx, .xls, .xlsm): Returns JSON 2D array
                          * sheet: "Sheet1" (name) or "0" (index as string, 0-based)
                          * range: ALWAYS use FROM:TO format (e.g., "A1:D100", "C1:C1", "B2:B50")
                          * offset/length work as row pagination (optional fallback)
                        - Images (PNG, JPEG, GIF, WebP): Base64 encoded viewable content
                        - PDF: Extracts text content as markdown with page structure
                          * offset/length work as page pagination (0-based)
                          * Includes embedded images when available

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ReadFileArgsSchema),
        annotations: {
            title: "Read File or URL",
            readOnlyHint: true,
            openWorldHint: true,
        },
    },
    {
        name: "read_multiple_files",
        description: `
                        Read the contents of multiple files simultaneously.
                        
                        Each file's content is returned with its path as a reference.
                        Handles text files normally and renders images as viewable content.
                        Recognized image types: PNG, JPEG, GIF, WebP.
                        
                        Failed reads for individual files won't stop the entire operation.
                        Only works within allowed directories.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ReadMultipleFilesArgsSchema),
        annotations: {
            title: "Read Multiple Files",
            readOnlyHint: true,
        },
    },
    {
        name: "write_file",
        description: `
                        Write or append to file contents.

                        IMPORTANT: DO NOT use this tool to create PDF files. Use 'write_pdf' for all PDF creation tasks.

                        CHUNKING IS STANDARD PRACTICE: Always write files in chunks of 25-30 lines maximum.
                        This is the normal, recommended way to write files - not an emergency measure.

                        STANDARD PROCESS FOR ANY FILE:
                        1. FIRST → write_file(filePath, firstChunk, {mode: 'rewrite'})  [≤30 lines]
                        2. THEN → write_file(filePath, secondChunk, {mode: 'append'})   [≤30 lines]
                        3. CONTINUE → write_file(filePath, nextChunk, {mode: 'append'}) [≤30 lines]

                        ALWAYS CHUNK PROACTIVELY - don't wait for performance warnings!

                        WHEN TO CHUNK (always be proactive):
                        1. Any file expected to be longer than 25-30 lines
                        2. When writing multiple files in sequence
                        3. When creating documentation, code files, or configuration files

                        HANDLING CONTINUATION ("Continue" prompts):
                        If user asks to "Continue" after an incomplete operation:
                        1. Read the file to see what was successfully written
                        2. Continue writing ONLY the remaining content using {mode: 'append'}
                        3. Keep chunks to 25-30 lines each

                        FORMAT HANDLING (by extension):
                        - Text files: String content
                        - Excel (.xlsx, .xls, .xlsm): JSON 2D array or {"SheetName": [[...]]}
                          Example: '[["Name","Age"],["Alice",30]]'

                        Files over 50 lines will generate performance notes but are still written successfully.
                        Only works within allowed directories.

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(WriteFileArgsSchema),
        annotations: {
            title: "Write File",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "write_pdf",
        description: `
                        Create a new PDF file or modify an existing one.

                        THIS IS THE ONLY TOOL FOR CREATING AND MODIFYING PDF FILES.

                        RULES ABOUT FILENAMES:
                        - When creating a new PDF, 'outputPath' MUST be provided and MUST use a new unique filename (e.g., "result_01.pdf", "analysis_2025_01.pdf", etc.).

                        MODES:
                        1. CREATE NEW PDF:
                           - Pass a markdown string as 'content'.
                           write_pdf(path="doc.pdf", content="# Title\\n\\nBody text...")

                        2. MODIFY EXISTING PDF:
                           - Pass array of operations as 'content'.
                           - NEVER overwrite the original file.
                           - ALWAYS provide a new filename in 'outputPath'.
                           - After modifying, show original file path and new file path to user.

                           write_pdf(path="doc.pdf", content=[
                               { type: "delete", pageIndexes: [0, 2] },
                               { type: "insert", pageIndex: 1, markdown: "# New Page" }
                           ])

                        OPERATIONS:
                        - delete: Remove pages by 0-based index.
                          { type: "delete", pageIndexes: [0, 1, 5] }

                        - insert: Add pages at a specific 0-based index.
                          { type: "insert", pageIndex: 0, markdown: "..." }
                          { type: "insert", pageIndex: 5, sourcePdfPath: "/path/to/source.pdf" }

                        PAGE BREAKS:
                        To force a page break, use this HTML element:
                        <div style="page-break-before: always;"></div>
                        
                        Example:
                        "# Page 1\\n\\n<div style=\\"page-break-before: always;\\"></div>\\n\\n# Page 2"

                        ADVANCED STYLING:
                        HTML/CSS and inline SVG are supported for:
                        - Text styling: colors, sizes, alignment, highlights
                        - Boxes: borders, backgrounds, padding, rounded corners
                        - SVG graphics: charts, diagrams, icons, shapes
                        - Images: <img src="/absolute/path/image.jpg" width="300" /> or ![alt](/path/image.jpg)

                        Supports standard markdown features including headers, lists, code blocks, tables, and basic formatting.

                        Only works within allowed directories.

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(WritePdfArgsSchema),
        annotations: {
            title: "Write/Modify PDF",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
            // destructiveHint removed for new PDF creation? No, creating is constructive?
        },
    },
    {
        name: "create_directory",
        description: `
                        Create a new directory or ensure a directory exists.
                        
                        Can create multiple nested directories in one operation.
                        Only works within allowed directories.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(CreateDirectoryArgsSchema),
        annotations: {
            title: "Create Directory",
            readOnlyHint: false,
            destructiveHint: false,
        },
    },
    {
        name: "list_directory",
        description: `
                        Get a detailed listing of all files and directories in a specified path.
                        
                        Use this instead of 'execute_command' with ls/dir commands.
                        Results distinguish between files and directories with [FILE] and [DIR] prefixes.
                        
                        Supports recursive listing with the 'depth' parameter (default: 2):
                        - depth=1: Only direct contents of the directory
                        - depth=2: Contents plus one level of subdirectories
                        - depth=3+: Multiple levels deep
                        
                        CONTEXT OVERFLOW PROTECTION:
                        - Top-level directory shows ALL items
                        - Nested directories are limited to 100 items maximum per directory
                        - When a nested directory has more than 100 items, you'll see a warning like:
                          [WARNING] node_modules: 500 items hidden (showing first 100 of 600 total)
                        - This prevents overwhelming the context with large directories like node_modules
                        
                        Results show full relative paths from the root directory being listed.
                        Example output with depth=2:
                        [DIR] src
                        [FILE] src/index.ts
                        [DIR] src/tools
                        [FILE] src/tools/filesystem.ts
                        
                        If a directory cannot be accessed, it will show [DENIED] instead.
                        Only works within allowed directories.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ListDirectoryArgsSchema),
        annotations: {
            title: "List Directory Contents",
            readOnlyHint: true,
        },
    },
    {
        name: "move_file",
        description: `
                        Move or rename files and directories.
                        
                        Can move files between directories and rename them in a single operation.
                        Both source and destination must be within allowed directories.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(MoveFileArgsSchema),
        annotations: {
            title: "Move/Rename File",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "start_search",
        description: `
                        Start a streaming search that can return results progressively.
                        
                        SEARCH STRATEGY GUIDE:
                        Choose the right search type based on what the user is looking for:
                        
                        USE searchType="files" WHEN:
                        - User asks for specific files: "find package.json", "locate config files"
                        - Pattern looks like a filename: "*.js", "README.md", "test-*.tsx" 
                        - User wants to find files by name/extension: "all TypeScript files", "Python scripts"
                        - Looking for configuration/setup files: ".env", "dockerfile", "tsconfig.json"
                        
                        USE searchType="content" WHEN:
                        - User asks about code/logic: "authentication logic", "error handling", "API calls"
                        - Looking for functions/variables: "getUserData function", "useState hook"
                        - Searching for text/comments: "TODO items", "FIXME comments", "documentation"
                        - Finding patterns in code: "console.log statements", "import statements"
                        - User describes functionality: "components that handle login", "files with database queries"
                        
                        WHEN UNSURE OR USER REQUEST IS AMBIGUOUS:
                        Run TWO searches in parallel - one for files and one for content:
                        
                        Example approach for ambiguous queries like "find authentication stuff":
                        1. Start file search: searchType="files", pattern="auth"
                        2. Simultaneously start content search: searchType="content", pattern="authentication"  
                        3. Present combined results: "Found 3 auth-related files and 8 files containing authentication code"
                        
                        SEARCH TYPES:
                        - searchType="files": Find files by name (pattern matches file names)
                        - searchType="content": Search inside files for text patterns
                        
                        PATTERN MATCHING MODES:
                        - Default (literalSearch=false): Patterns are treated as regular expressions
                        - Literal (literalSearch=true): Patterns are treated as exact strings
                        
                        WHEN TO USE literalSearch=true:
                        Use literal search when searching for code patterns with special characters:
                        - Function calls with parentheses and quotes
                        - Array access with brackets
                        - Object methods with dots and parentheses
                        - File paths with backslashes
                        - Any pattern containing: . * + ? ^ $ { } [ ] | \\ ( )
                        
                        IMPORTANT PARAMETERS:
                        - pattern: What to search for (file names OR content text)
                        - literalSearch: Use exact string matching instead of regex (default: false)
                        - filePattern: Optional filter to limit search to specific file types (e.g., "*.js", "package.json")
                        - ignoreCase: Case-insensitive search (default: true). Works for both file names and content.
                        - earlyTermination: Stop search early when exact filename match is found (optional: defaults to true for file searches, false for content searches)
                        
                        DECISION EXAMPLES:
                        - "find package.json" → searchType="files", pattern="package.json" (specific file)
                        - "find authentication components" → searchType="content", pattern="authentication" (looking for functionality)
                        - "locate all React components" → searchType="files", pattern="*.tsx" or "*.jsx" (file pattern)
                        - "find TODO comments" → searchType="content", pattern="TODO" (text in files)
                        - "show me login files" → AMBIGUOUS → run both: files with "login" AND content with "login"
                        - "find config" → AMBIGUOUS → run both: config files AND files containing config code
                        
                        COMPREHENSIVE SEARCH EXAMPLES:
                        - Find package.json files: searchType="files", pattern="package.json"
                        - Find all JS files: searchType="files", pattern="*.js"
                        - Search for TODO in code: searchType="content", pattern="TODO", filePattern="*.js|*.ts"
                        - Search for exact code: searchType="content", pattern="toast.error('test')", literalSearch=true
                        - Ambiguous request "find auth stuff": Run two searches:
                          1. searchType="files", pattern="auth"
                          2. searchType="content", pattern="authentication"
                        
                        PRO TIP: When user requests are ambiguous about whether they want files or content,
                        run both searches concurrently and combine results for comprehensive coverage.
                        
                        Unlike regular search tools, this starts a background search process and returns
                        immediately with a session ID. Use get_more_search_results to get results as they
                        come in, and stop_search to stop the search early if needed.
                        
                        Perfect for large directories where you want to see results immediately and
                        have the option to cancel if the search takes too long or you find what you need.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(StartSearchArgsSchema),
        annotations: {
            title: "Start Search",
            readOnlyHint: true,
        },
    },
    {
        name: "get_more_search_results",
        description: `
                        Get more results from an active search with offset-based pagination.
                        
                        Supports partial result reading with:
                        - 'offset' (start result index, default: 0)
                          * Positive: Start from result N (0-based indexing)
                          * Negative: Read last N results from end (tail behavior)
                        - 'length' (max results to read, default: 100)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail results)
                        
                        Examples:
                        - offset: 0, length: 100     → First 100 results
                        - offset: 200, length: 50    → Results 200-249
                        - offset: -20                → Last 20 results
                        - offset: -5, length: 10     → Last 5 results (length ignored)
                        
                        Returns only results in the specified range, along with search status.
                        Works like read_process_output - call this repeatedly to get progressive
                        results from a search started with start_search.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(GetMoreSearchResultsArgsSchema),
        annotations: {
            title: "Get Search Results",
            readOnlyHint: true,
        },
    },
    {
        name: "stop_search",
        description: `
                        Stop an active search.
                        
                        Stops the background search process gracefully. Use this when you've found
                        what you need or if a search is taking too long. Similar to force_terminate
                        for terminal processes.
                        
                        The search will still be available for reading final results until it's
                        automatically cleaned up after 5 minutes.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(StopSearchArgsSchema),
        annotations: {
            title: "Stop Search",
            readOnlyHint: false,
            destructiveHint: false,
        },
    },
    {
        name: "list_searches",
        description: `
                        List all active searches.
                        
                        Shows search IDs, search types, patterns, status, and runtime.
                        Similar to list_sessions for terminal processes. Useful for managing
                        multiple concurrent searches.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ListSearchesArgsSchema),
        annotations: {
            title: "List Active Searches",
            readOnlyHint: true,
        },
    },
    {
        name: "get_file_info",
        description: `
                        Retrieve detailed metadata about a file or directory including:
                        - size
                        - creation time
                        - last modified time
                        - permissions
                        - type
                        - lineCount (for text files)
                        - lastLine (zero-indexed number of last line, for text files)
                        - appendPosition (line number for appending, for text files)
                        - sheets (for Excel files - array of {name, rowCount, colCount})

                        Only works within allowed directories.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(GetFileInfoArgsSchema),
        annotations: {
            title: "Get File Information",
            readOnlyHint: true,
        },
    },
    // Note: list_allowed_directories removed - use get_config to check allowedDirectories

    // Editing tools
    {
        name: "edit_block",
        description: `
                        Apply surgical edits to files.

                        BEST PRACTICE: Make multiple small, focused edits rather than one large edit.
                        Each edit_block call should change only what needs to be changed - include just enough
                        context to uniquely identify the text being modified.

                        FORMAT HANDLING (by extension):

                        EXCEL FILES (.xlsx, .xls, .xlsm) - Range Update mode:
                        Takes:
                        - file_path: Path to the Excel file
                        - range: ALWAYS use FROM:TO format - "SheetName!A1:C10" or "SheetName!C1:C1"
                        - content: 2D array, e.g., [["H1","H2"],["R1","R2"]]

                        TEXT FILES - Find/Replace mode:
                        Takes:
                        - file_path: Path to the file to edit
                        - old_string: Text to replace
                        - new_string: Replacement text
                        - expected_replacements: Optional number of replacements (default: 1)

                        By default, replaces only ONE occurrence of the search text.
                        To replace multiple occurrences, provide expected_replacements with
                        the exact number of matches expected.

                        UNIQUENESS REQUIREMENT: When expected_replacements=1 (default), include the minimal
                        amount of context necessary (typically 1-3 lines) before and after the change point,
                        with exact whitespace and indentation.

                        When editing multiple sections, make separate edit_block calls for each distinct change
                        rather than one large replacement.

                        When a close but non-exact match is found, a character-level diff is shown in the format:
                        common_prefix{-removed-}{+added+}common_suffix to help you identify what's different.

                        Similar to write_file, there is a configurable line limit (fileWriteLineLimit) that warns
                        if the edited file exceeds this limit. If this happens, consider breaking your edits into
                        smaller, more focused changes.

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(EditBlockArgsSchema),
        annotations: {
            title: "Edit Block",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },

    // Terminal tools
    {
        name: "start_process",
        description: `
                        Start a new terminal process with intelligent state detection.
                        
                        PRIMARY TOOL FOR FILE ANALYSIS AND DATA PROCESSING
                        This is the ONLY correct tool for analyzing local files (CSV, JSON, logs, etc.).
                        The analysis tool CANNOT access local files and WILL FAIL - always use processes for file-based work.
                        
                        CRITICAL RULE: For ANY local file work, ALWAYS use this tool + interact_with_process, NEVER use analysis/REPL tool.
                        
                        REQUIRED WORKFLOW FOR LOCAL FILES:
                        1. start_process("python3 -i") - Start Python REPL for data analysis
                        2. interact_with_process(pid, "import pandas as pd, numpy as np")
                        3. interact_with_process(pid, "df = pd.read_csv('/absolute/path/file.csv')")
                        4. interact_with_process(pid, "print(df.describe())")
                        5. Continue analysis with pandas, matplotlib, seaborn, etc.
                        
                        COMMON FILE ANALYSIS PATTERNS:
                        • start_process("python3 -i") → Python REPL for data analysis (RECOMMENDED)
                        • start_process("node -i") → Node.js REPL for JSON processing
                        • start_process("node:local") → Node.js on MCP server (stateless, ES imports, all code in one call)
                        • start_process("cut -d',' -f1 file.csv | sort | uniq -c") → Quick CSV analysis
                        • start_process("wc -l /path/file.csv") → Line counting
                        • start_process("head -10 /path/file.csv") → File preview
                        
                        BINARY FILE SUPPORT:
                        For PDF, Excel, Word, archives, databases, and other binary formats, use process tools with appropriate libraries or command-line utilities.
                        
                        INTERACTIVE PROCESSES FOR DATA ANALYSIS:
                        For code/calculations, use in this priority order:
                        1. start_process("python3 -i") - Python REPL (preferred)
                        2. start_process("node -i") - Node.js REPL (when Python unavailable)
                        3. start_process("node:local") - Node.js fallback (when node -i fails)
                        4. Use interact_with_process() to send commands
                        5. Use read_process_output() to get responses
                        When Python is unavailable, prefer Node.js over shell for calculations.
                        Node.js: Always use ES import syntax (import x from 'y'), not require().

                        SMART DETECTION:
                        - Detects REPL prompts (>>>, >, $, etc.)
                        - Identifies when process is waiting for input
                        - Recognizes process completion vs timeout
                        - Early exit prevents unnecessary waiting
                        
                        STATES DETECTED:
                        Process waiting for input (shows prompt)
                        Process finished execution
                        Process running (use read_process_output)

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_exit, timeout)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit
                        Use this to identify missed optimization opportunities and improve detection patterns.
                        
                        ALWAYS USE FOR: Local file analysis, CSV processing, data exploration, system commands
                        NEVER USE ANALYSIS TOOL FOR: Local file access (analysis tool is browser-only and WILL FAIL)

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(StartProcessArgsSchema),
        annotations: {
            title: "Start Terminal Process",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
            // destructiveHint removed? No, it's there.
        },
    },
    {
        name: "read_process_output",
        description: `
                        Read output from a running process with file-like pagination support.
                        
                        Supports partial output reading with offset and length parameters (like read_file):
                        - 'offset' (start line, default: 0)
                          * offset=0: Read NEW output since last read (default, like old behavior)
                          * Positive: Read from absolute line position
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting)
                        
                        Examples:
                        - offset: 0, length: 100     → First 100 NEW lines since last read
                        - offset: 0                  → All new lines (respects config limit)
                        - offset: 500, length: 50    → Lines 500-549 (absolute position)
                        - offset: -20                → Last 20 lines (tail)
                        - offset: -50, length: 10    → Start 50 from end, read 10 lines
                        
                        OUTPUT PROTECTION:
                        - Uses same fileReadLineLimit as read_file (default: 1000 lines)
                        - Returns status like: [Reading 100 lines from line 0 (total: 5000 lines, 4900 remaining)]
                        - Prevents context overflow from verbose processes
                        
                        SMART FEATURES:
                        - For offset=0, waits up to timeout_ms for new output to arrive
                        - Detects REPL prompts and process completion
                        - Shows process state (waiting for input, finished, etc.)
                        
                        DETECTION STATES:
                        Process waiting for input (ready for interact_with_process)
                        Process finished execution
                        Timeout reached (may still be running)

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ReadProcessOutputArgsSchema),
        annotations: {
            title: "Read Process Output",
            readOnlyHint: true,
        },
    },
    {
        name: "interact_with_process",
        description: `
                        Send input to a running process and automatically receive the response.
                        
                        CRITICAL: THIS IS THE PRIMARY TOOL FOR ALL LOCAL FILE ANALYSIS
                        For ANY local file analysis (CSV, JSON, data processing), ALWAYS use this instead of the analysis tool.
                        The analysis tool CANNOT access local files and WILL FAIL - use processes for ALL file-based work.
                        
                        FILE ANALYSIS PRIORITY ORDER (MANDATORY):
                        1. ALWAYS FIRST: Use this tool (start_process + interact_with_process) for local data analysis
                        2. ALTERNATIVE: Use command-line tools (cut, awk, grep) for quick processing  
                        3. NEVER EVER: Use analysis tool for local file access (IT WILL FAIL)
                        
                        REQUIRED INTERACTIVE WORKFLOW FOR FILE ANALYSIS:
                        1. Start REPL: start_process("python3 -i")
                        2. Load libraries: interact_with_process(pid, "import pandas as pd, numpy as np")
                        3. Read file: interact_with_process(pid, "df = pd.read_csv('/absolute/path/file.csv')")
                        4. Analyze: interact_with_process(pid, "print(df.describe())")
                        5. Continue: interact_with_process(pid, "df.groupby('column').size()")
                        
                        BINARY FILE PROCESSING WORKFLOWS:
                        Use appropriate Python libraries (PyPDF2, pandas, docx2txt, etc.) or command-line tools for binary file analysis.
                        
                        SMART DETECTION:
                        - Automatically waits for REPL prompt (>>>, >, etc.)
                        - Detects errors and completion states
                        - Early exit prevents timeout delays
                        - Clean output formatting (removes prompts)
                        
                        SUPPORTED REPLs:
                        - Python: python3 -i (RECOMMENDED for data analysis)
                        - Node.js: node -i
                        - R: R
                        - Julia: julia
                        - Shell: bash, zsh
                        - Database: mysql, postgres
                        
                        PARAMETERS:
                        - pid: Process ID from start_process
                        - input: Code/command to execute
                        - timeout_ms: Max wait (default: 8000ms)
                        - wait_for_prompt: Auto-wait for response (default: true)
                        - verbose_timing: Enable detailed performance telemetry (default: false)

                        Returns execution result with status indicators.

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_finished, timeout, no_wait)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit
                        Use this to identify slow interactions and optimize detection patterns.

                        ALWAYS USE FOR: CSV analysis, JSON processing, file statistics, data visualization prep, ANY local file work
                        NEVER USE ANALYSIS TOOL FOR: Local file access (it cannot read files from disk and WILL FAIL)

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(InteractWithProcessArgsSchema),
        annotations: {
            title: "Send Input to Process",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
        },
    },
    {
        name: "force_terminate",
        description: `
                        Force terminate a running terminal session.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ForceTerminateArgsSchema),
        annotations: {
            title: "Force Terminate Process",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "list_sessions",
        description: `
                        List all active terminal sessions.
                        
                        Shows session status including:
                        - PID: Process identifier  
                        - Blocked: Whether session is waiting for input
                        - Runtime: How long the session has been running
                        
                        DEBUGGING REPLs:
                        - "Blocked: true" often means REPL is waiting for input
                        - Use this to verify sessions are running before sending input
                        - Long runtime with blocked status may indicate stuck process
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ListSessionsArgsSchema),
        annotations: {
            title: "List Terminal Sessions",
            readOnlyHint: true,
        },
    },
    {
        name: "list_processes",
        description: `
                        List all running processes.
                        
                        Returns process information including PID, command name, CPU usage, and memory usage.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(ListProcessesArgsSchema),
        annotations: {
            title: "List Running Processes",
            readOnlyHint: true,
        },
    },
    {
        name: "kill_process",
        description: `
                        Terminate a running process by PID.

                        Use with caution as this will forcefully terminate the specified process.

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(KillProcessArgsSchema),
        annotations: {
            title: "Kill Process",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: false,
        },
    },
    {
        name: "get_usage_stats",
        description: `
                        Get usage statistics for debugging and analysis.
                        
                        Returns summary of tool usage, success/failure rates, and performance metrics.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(GetUsageStatsArgsSchema),
        annotations: {
            title: "Get Usage Statistics",
            readOnlyHint: true,
        },
    },
    {
        name: "get_recent_tool_calls",
        description: `
                        Get recent tool call history with their arguments and outputs.
                        Returns chronological list of tool calls made during this session.
                        
                        Useful for:
                        - Onboarding new chats about work already done
                        - Recovering context after chat history loss
                        - Debugging tool call sequences
                        
                        Note: Does not track its own calls or other meta/query tools.
                        History kept in memory (last 1000 calls, lost on restart).
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(GetRecentToolCallsArgsSchema),
        annotations: {
            title: "Get Recent Tool Calls",
            readOnlyHint: true,
        },
    },
    {
        name: "give_feedback_to_desktop_commander",
        description: `
                        Open feedback form in browser to provide feedback about Desktop Commander.
                        
                        IMPORTANT: This tool simply opens the feedback form - no pre-filling available.
                        The user will fill out the form manually in their browser.
                        
                        WORKFLOW:
                        1. When user agrees to give feedback, just call this tool immediately
                        2. No need to ask questions or collect information
                        3. Tool opens form with only usage statistics pre-filled automatically:
                           - tool_call_count: Number of commands they've made
                           - days_using: How many days they've used Desktop Commander
                           - platform: Their operating system (Mac/Windows/Linux)
                           - client_id: Analytics identifier
                        
                        All survey questions will be answered directly in the form:
                        - Job title and technical comfort level
                        - Company URL for industry context
                        - Other AI tools they use
                        - Desktop Commander's biggest advantage
                        - How they typically use it
                        - Recommendation likelihood (0-10)
                        - User study participation interest
                        - Email and any additional feedback
                        
                        EXAMPLE INTERACTION:
                        User: "sure, I'll give feedback"
                        Claude: "Perfect! Let me open the feedback form for you."
                        [calls tool immediately]
                        
                        No parameters are needed - just call the tool to open the form.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(GiveFeedbackArgsSchema),
        annotations: {
            title: "Give Feedback",
            readOnlyHint: false,
            openWorldHint: true,
            // destructiveHint removed? No, openWorldHint?
        },
    },
    {
        name: "get_prompts",
        description: `
                        Retrieve a specific Desktop Commander onboarding prompt by ID and execute it.
                        
                        SIMPLIFIED ONBOARDING V2: This tool only supports direct prompt retrieval.
                        The onboarding system presents 5 options as a simple numbered list:
                        
                        1. Organize my Downloads folder (promptId: 'onb2_01')
                        2. Explain a codebase or repository (promptId: 'onb2_02')
                        3. Create organized knowledge base (promptId: 'onb2_03')
                        4. Analyze a data file (promptId: 'onb2_04')
                        5. Check system health and resources (promptId: 'onb2_05')
                        
                        USAGE:
                        When user says "1", "2", "3", "4", or "5" from onboarding:
                        - "1" → get_prompts(action='get_prompt', promptId='onb2_01')
                        - "2" → get_prompts(action='get_prompt', promptId='onb2_02')
                        - "3" → get_prompts(action='get_prompt', promptId='onb2_03')
                        - "4" → get_prompts(action='get_prompt', promptId='onb2_04')
                        - "5" → get_prompts(action='get_prompt', promptId='onb2_05')
                        
                        The prompt content will be injected and execution begins immediately.

                        ${CMD_PREFIX_DESCRIPTION}`,
        inputSchema: withDeviceSelection(GetPromptsArgsSchema),
        annotations: {
            title: "Get Prompts",
            readOnlyHint: true,
        },
    }
];
