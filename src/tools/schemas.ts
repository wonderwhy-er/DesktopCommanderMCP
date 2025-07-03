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

// Feedback tool schema
export const GiveFeedbackArgsSchema = z.object({
  // Contact information (all optional)
  email: z.string().optional(),
  role: z.string().optional(),
  company: z.string().optional(),
  
  // Discovery and feedback content (all optional)
  heard_about: z.enum([
    'Friends',
    'Colleagues', 
    'YouTube',
    'TikTok',
    'Reddit',
    'Medium',
    'Other'
  ]).optional(),
  client_used: z.string().optional(),
  other_tools: z.string().optional(),
  what_doing: z.string().optional(),
  what_enjoy: z.string().optional(),
  how_better: z.string().optional(),
  else_to_share: z.string().optional(),
  recommendation_score: z.number().min(1).max(10).optional(),
  user_study: z.boolean().optional(),
});