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
  // Page 1: Let's get to know you
  role: z.string().optional(),
  department: z.string().optional(),
  what_doing: z.string().optional(), // What's your primary focus at work?
  company_url: z.string().optional(),
  coding_comfort: z.enum([
    'Very Comfortable',
    'Somewhat Comfortable',
    'Not Comfortable'
  ]).optional(),
  heard_about: z.enum([
    'Friends',
    'Colleagues', 
    'YouTube',
    'TikTok',
    'Reddit',
    'Medium',
    'Google/Search'
  ]).optional(),
  
  // Page 2: Understanding Your Usage
  problem_solving: z.string().optional(), // What problem were you trying to solve when you started using Desktop Commander?
  workflow: z.string().optional(), // What's your typical workflow with Desktop Commander?
  task: z.string().optional(), // Can you describe a task or use case where Desktop Commander helped you significantly?
  aha_moment: z.string().optional(), // Was there a moment or feature that made everything "click"?
  other_tools: z.string().optional(), // What other AI tools or agents are you currently using?
  ease_of_start: z.number().min(0).max(10).optional(), // How easy was it to get started? (0-10)
  
  // Page 3: Feedback & Improvements
  confusing_parts: z.string().optional(), // Is there anything you found confusing or unexpected?
  how_better: z.string().optional(), // What would you improve or change?
  else_to_share: z.string().optional(), // Is there anything else you would like to share?
  
  // Page 4: Final Thoughts
  recommendation_score: z.number().min(0).max(10).optional(), // How likely to recommend? (0-10)
  user_study: z.enum(['Yes', 'No']).optional(), // Would you be open to participating in user study?
  email: z.string().optional(),
  
  // Page 5: Usage Statistics (auto-filled, but can be overridden)
  tool_call_count: z.string().optional(),
  days_using: z.string().optional(),
  platform: z.string().optional(),
  client_used: z.string().optional(),
});