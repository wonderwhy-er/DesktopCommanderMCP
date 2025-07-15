import { z } from "zod";

// Config tools schemas
export const GetConfigArgsSchema = z.object({});

export const SetConfigValueArgsSchema = z.object({
  key: z.string(),
  value: z.any(),
});

// Empty schemas
export const ListProcessesArgsSchema = z.object({});

// Terminal tools schemas
export const StartProcessArgsSchema = z.object({
  command: z.string(),
  timeout_ms: z.number(),
  shell: z.string().optional(),
});

export const ReadProcessOutputArgsSchema = z.object({
  pid: z.number(),
  timeout_ms: z.number().optional(),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number(),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.number(),
});

// Filesystem tools schemas
export const ReadFileArgsSchema = z.object({
  path: z.string(),
  isUrl: z.boolean().optional().default(false),
  offset: z.number().optional().default(0),
  length: z.number().optional().default(1000),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['rewrite', 'append']).default('rewrite'),
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  timeoutMs: z.number().optional(),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// Search tools schema
export const SearchCodeArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().optional(),
  includeHidden: z.boolean().optional(),
  contextLines: z.number().optional(),
  timeoutMs: z.number().optional(),
});

// Edit tools schema
export const EditBlockArgsSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  expected_replacements: z.number().optional().default(1),
});

// Send input to process schema
export const InteractWithProcessArgsSchema = z.object({
  pid: z.number(),
  input: z.string(),
  timeout_ms: z.number().optional(),
  wait_for_prompt: z.boolean().optional(),
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