/**
 * SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
 * 
 * Copyright (c) 2025 Desktope Commander MCP Contributors
 * 
 * This file is licensed under the PolyForm Small Business License 1.0.0
 * See the LICENSE file in the /src/polyform directory for the full license text.
 */

import { z } from 'zod';

// Enhanced edit block schema with separate parameters for clarity
export const EditBlockArgsSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  expected_replacements: z.number().optional().default(1),
});
