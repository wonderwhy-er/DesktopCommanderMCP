import { z } from 'zod';

export const SSEConfigArgsSchema = z.object({
  // Required action: enable, disable, status, or restart
  action: z.enum(['enable', 'disable', 'status', 'restart']),

  // Optional port to use (only valid when action is 'enable' or 'restart')
  port: z.number().optional(),

  // Optional path to use (only valid when action is 'enable' or 'restart')
  path: z.string().optional(),
});

export type SSEConfigArgs = z.infer<typeof SSEConfigArgsSchema>;
