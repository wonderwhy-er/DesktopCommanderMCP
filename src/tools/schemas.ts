import { z } from "zod";

// Config tools schemas
export const GetConfigArgsSchema = z.object({
  // 'ui' marks calls the config-editor widget fires programmatically; they are
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const SetConfigValueArgsSchema = z.object({
  key: z.string().describe('Configuration key to update.'),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]).describe('New value for the selected configuration key; its type must match that key’s configuration contract.'),
  // 'ui' marks widget-fired calls; excluded from tool-call telemetry.
  origin: z.enum(['ui', 'llm']).optional(),
});

// Empty schemas
export const ListProcessesArgsSchema = z.object({});

// Terminal tools schemas
export const StartProcessArgsSchema = z.object({
  command: z.string().describe('Command or REPL/shell process to start. For an interactive Python REPL, use python -i or python3 -i.'),
  timeout_ms: z.number().describe('Maximum initial wait in milliseconds before returning process state/output.'),
  shell: z.string().optional().describe('Optional shell override; omit to use the configured default shell.'),
  verbose_timing: z.boolean().optional().describe('Include detailed timing diagnostics for process-state detection.'),
  // 'ui' marks widget-fired calls (e.g. open-in-folder/editor buttons);
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const ReadProcessOutputArgsSchema = z.object({
  pid: z.number().describe('Process ID returned by start_process.'),
  timeout_ms: z.number().optional().describe('Maximum wait in milliseconds for new output/state.'),
  offset: z.number().optional().describe('Line offset: 0 continues from the last read, positive is absolute, negative reads from the tail.'),
  length: z.number().optional().describe('Maximum lines to return; default comes from fileReadLineLimit.'),
  verbose_timing: z.boolean().optional().describe('Include detailed timing diagnostics.'),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number().describe('Process-session ID returned by start_process.'),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  // process.kill reads 0 and negative PIDs as process groups: 0 is the server's
  // own (on Windows the server itself), -1 every process the user may signal.
  // A refinement rather than .positive(), so the published schema is unchanged.
  pid: z.number().refine((pid) => pid > 0, { message: 'Number must be greater than 0' }).describe('Positive operating-system process ID to terminate.'),
});

// Filesystem tools schemas
export const ReadFileArgsSchema = z.object({
  path: z.string().describe('Local file path or URL when isUrl=true.'),
  isUrl: z.boolean().optional().default(false).describe('Set true to fetch path as a URL; URL reads are fetched in full.'),
  offset: z.number().optional().default(0).describe('Text line/PDF page/Excel row offset. Positive starts at that index; negative reads from the end where supported. For DOCX, any nonzero offset switches from outline view to raw XML.'),
  length: z.number().optional().default(1000).describe('Maximum text lines/PDF pages/Excel rows for positive offsets; ignored for negative tail offsets. DOCX raw-XML pagination requires a nonzero offset.'),
  sheet: z.string().optional().describe('Excel sheet name or zero-based sheet index encoded as a string.'),  // String only for MCP client compatibility (Cursor doesn't support union types in JSON Schema)
  range: z.string().optional().describe('Excel cell range in FROM:TO form, for example A1:D100.'),
  options: z.record(z.any()).optional().describe('Format-specific read options.'),
  // Whether the call came from the file-preview UI (refresh/navigation) or the
  // LLM. 'ui' calls are excluded from tool-call telemetry; see isUiOriginCall
  // in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()).describe('Local file paths to read in one call.'),
});

export const WriteFileArgsSchema = z.object({
  path: z.string().describe('Destination file path within allowed directories.'),
  content: z.string().describe('Content to write; structured formats may interpret it according to their documented format.'),
  mode: z.enum(['rewrite', 'append']).default('rewrite').describe('rewrite replaces file content; append adds to the end.'),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

// PDF modification schemas - exported for reuse
export const PdfInsertOperationSchema = z.object({
  type: z.literal('insert').describe('Insert pages into the target PDF.'),
  pageIndex: z.number().describe('Zero-based index where the new page or source PDF pages are inserted.'),
  markdown: z.string().optional().describe('Markdown/HTML/CSS/SVG content to render as inserted PDF page content.'),
  sourcePdfPath: z.string().optional().describe('Optional PDF whose pages are inserted at pageIndex.'),
  pdfOptions: z.object({}).passthrough().optional().describe('Render options applied to inserted markdown pages.'),
});

export const PdfDeleteOperationSchema = z.object({
  type: z.literal('delete').describe('Delete pages from the target PDF.'),
  pageIndexes: z.array(z.number()).describe('Zero-based page indexes to delete.'),
});

export const PdfOperationSchema = z.union([PdfInsertOperationSchema, PdfDeleteOperationSchema]);

export const WritePdfArgsSchema = z.object({
  path: z.string().describe('PDF path to create or modify. When outputPath is omitted, the result is written here.'),
  // Preprocess content to handle JSON strings that should be parsed as arrays
  content: z.preprocess(
    (val) => {
      // If it's a string that looks like JSON array, parse it
      if (typeof val === 'string' && val.trim().startsWith('[')) {
        try {
          return JSON.parse(val);
        } catch {
          // If parsing fails, return as-is (might be markdown content)
          return val;
        }
      }
      // Otherwise return as-is
      return val;
    },
    z.union([z.string(), z.array(PdfOperationSchema)])
  ).describe('Markdown string creates/renders a PDF; an operation array inserts or deletes pages in an existing PDF.'),
  outputPath: z.string().optional().describe('Optional alternate destination. Omit to write or overwrite path.'),
  options: z.object({}).passthrough().optional().describe('PDF render options for created or inserted markdown pages.'), // Allow passing options to md-to-pdf
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string().describe('Directory path to create, including missing parent directories.'),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string().describe('Directory path to list.'),
  depth: z.number().optional().default(2).describe('Maximum recursive directory depth; default 2.'),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
});

export const MoveFileArgsSchema = z.object({
  source: z.string().describe('Existing file or directory path to move or rename.'),
  destination: z.string().describe('Destination path.'),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string().describe('File or directory path whose metadata should be returned.'),
});

// Edit tools schema - SIMPLIFIED from three modes to two
// Previously supported: text replacement, location-based edits (edits array), and range rewrites
// Now supports only: text replacement and range rewrites
// Removed 'edits' array parameter - location-based surgical edits were complex and unnecessary
// Range rewrites are more powerful and cover all structured file editing needs
export const EditBlockArgsSchema = z.object({
  file_path: z.string().describe('File to edit.'),
  // Text file string replacement
  old_string: z.string().optional().describe('Exact text to replace. For DOCX, use an exact XML fragment from read_file raw-XML output (nonzero offset).'),
  new_string: z.string().optional().describe('Replacement text/XML; may be empty to delete the matched text.'),
  expected_replacements: z.number().optional().default(1).describe('Expected match count; a mismatch rejects the edit instead of applying an ambiguous replacement.'),
  // Structured file range rewrite (Excel, etc.)
  range: z.string().optional().describe('Structured-file range to rewrite, for example an Excel cell range.'),
  content: z.any().optional().describe('Replacement content for structured range mode.'),
  options: z.record(z.any()).optional().describe('Format-specific edit options.'),
  // 'ui' when fired by the file-preview UI, else 'llm'. 'ui' calls are
  // excluded from tool-call telemetry; see isUiOriginCall in server.ts.
  origin: z.enum(['ui', 'llm']).optional(),
}).refine(
  data => {
    // Helper to check if value is actually provided (not undefined, not empty string)
    const hasValue = (v: unknown) => v !== undefined && v !== '';
    return (hasValue(data.old_string) && data.new_string !== undefined) ||
           (hasValue(data.range) && hasValue(data.content));
  },
  { message: "Must provide either (old_string + new_string) or (range + content)" }
);

// Send input to process schema
export const InteractWithProcessArgsSchema = z.object({
  pid: z.number().describe('Process ID returned by start_process.'),
  input: z.string().describe('Text or command to send to the interactive process.'),
  timeout_ms: z.number().optional().describe('Maximum wait in milliseconds for response/output.'),
  wait_for_prompt: z.boolean().optional().describe('Wait for a recognized prompt/state before returning when true.'),
  verbose_timing: z.boolean().optional().describe('Include detailed timing diagnostics.'),
});

// Usage stats schema
export const GetUsageStatsArgsSchema = z.object({});

// Feedback tool schema - no pre-filled parameters, all user input
export const GiveFeedbackArgsSchema = z.object({
  // No parameters needed - form will be filled manually by user
  // Only auto-filled hidden fields remain:
  // - tool_call_count (auto)
  // - days_using (auto) 
  // - platform (auto)
  // - client_id (auto)
});

/** A whole number (at least `min`, if given), rejected with a message that says so */
function wholeNumber(name: string, min?: number) {
  const message = `${name} must be a whole number${min === undefined ? '' : ` of at least ${min}`}`;
  const number = z.number().int({ message });
  return min === undefined ? number : number.min(min, { message });
}

// Search schemas (renamed for natural language)
export const StartSearchArgsSchema = z.object({
  path: z.string().describe('Root directory to search.'),
  pattern: z.string().describe('Filename pattern for files mode or content pattern for content mode.'),
  searchType: z.enum(['files', 'content']).default('files').describe('files matches file names; content searches inside files.'),
  filePattern: z.string().optional().describe('Optional file-name/type filter applied to content searches.'),
  ignoreCase: z.boolean().optional().default(true).describe('Case-insensitive matching when true.'),
  maxResults: wholeNumber('maxResults', 0).optional().describe('Maximum results; 0 means no limit.'),
  includeHidden: z.boolean().optional().default(false).describe('Include hidden files and directories when true.'),
  contextLines: wholeNumber('contextLines', 0).optional().default(5).describe('Context lines around content matches; default 5.'),
  timeout_ms: wholeNumber('timeout_ms', 0).optional().describe('Search timeout in milliseconds; 0 means no time limit.'),
  earlyTermination: z.boolean().optional().describe('Stop early on an exact filename match. Default: true for files mode, false for content mode.'),
  literalSearch: z.boolean().optional().default(false).describe('Treat pattern as an exact literal string instead of a regular expression.'),
  // 'ui' marks widget-fired calls (e.g. markdown link-target search);
  // excluded from tool-call telemetry (see isUiOriginCall in server.ts).
  origin: z.enum(['ui', 'llm']).optional(),
});

export const GetMoreSearchResultsArgsSchema = z.object({
  sessionId: z.string().describe('Search session ID returned by start_search.'),
  offset: wholeNumber('offset').optional().default(0).describe('Result offset within the search session; default 0.'),
  length: wholeNumber('length', 1).optional().default(100).describe('Maximum results to return; default 100.'),
});

export const StopSearchArgsSchema = z.object({
  sessionId: z.string().describe('Search session ID returned by start_search.'),
});

export const ListSearchesArgsSchema = z.object({});

// Tool history schema
export const GetRecentToolCallsArgsSchema = z.object({
  maxResults: z.number().min(1).max(1000).optional().default(50).describe('Maximum history entries to return; 1–1000, default 50.'),
  toolName: z.string().optional().describe('Optional tool-name filter.'),
  since: z.string().datetime().optional().describe('Optional ISO datetime lower bound for returned history.'),
});

export const TrackUiEventArgsSchema = z.object({
  event: z.string().min(1).max(80),
  component: z.string().optional().default('file_preview'),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({}),
});

/**
 * Map of tool name -> argument schema, used by the dispatcher to detect and warn
 * about parameters a caller sent that the tool does not support. Keep in sync
 * with the tool definitions in server.ts.
 */
export const toolArgSchemas: Record<string, z.ZodTypeAny> = {
  get_config: GetConfigArgsSchema,
  set_config_value: SetConfigValueArgsSchema,
  read_file: ReadFileArgsSchema,
  read_multiple_files: ReadMultipleFilesArgsSchema,
  write_file: WriteFileArgsSchema,
  write_pdf: WritePdfArgsSchema,
  create_directory: CreateDirectoryArgsSchema,
  list_directory: ListDirectoryArgsSchema,
  move_file: MoveFileArgsSchema,
  start_search: StartSearchArgsSchema,
  get_more_search_results: GetMoreSearchResultsArgsSchema,
  stop_search: StopSearchArgsSchema,
  list_searches: ListSearchesArgsSchema,
  get_file_info: GetFileInfoArgsSchema,
  edit_block: EditBlockArgsSchema,
  start_process: StartProcessArgsSchema,
  read_process_output: ReadProcessOutputArgsSchema,
  interact_with_process: InteractWithProcessArgsSchema,
  force_terminate: ForceTerminateArgsSchema,
  list_sessions: ListSessionsArgsSchema,
  list_processes: ListProcessesArgsSchema,
  kill_process: KillProcessArgsSchema,
  get_usage_stats: GetUsageStatsArgsSchema,
  get_recent_tool_calls: GetRecentToolCallsArgsSchema,
  give_feedback_to_desktop_commander: GiveFeedbackArgsSchema,
  track_ui_event: TrackUiEventArgsSchema,
};
