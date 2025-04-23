/**
 * SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
 * 
 * Copyright (c) 2025 Desktope Commander MCP Contributors
 * 
 * This file is licensed under the PolyForm Small Business License 1.0.0
 * See the LICENSE file in the /src/polyform directory for the full license text.
 */

import { performSearchReplace } from './edit.js';
import { EditBlockArgsSchema } from './schemas.js';
import { ServerResult } from '../../types.js';

/**
 * Handle edit_block command with enhanced functionality
 * - Supports multiple replacements
 * - Validates expected replacements count
 * - Provides detailed error messages
 */
export async function handleEnhancedEditBlock(args: unknown): Promise<ServerResult> {
    const parsed = EditBlockArgsSchema.parse(args);
    
    const searchReplace = {
        search: parsed.old_string,
        replace: parsed.new_string
    };

    return performSearchReplace(parsed.file_path, searchReplace, parsed.expected_replacements);
}
