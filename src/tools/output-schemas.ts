import { z } from 'zod';
import { CONFIG_FIELD_KEYS, type ConfigFieldKey } from '../config-field-definitions.js';

/**
 * An incremental MCP output contract for get_config (#689).
 *
 * Keep config extensible: runtime/system fields vary by platform and client.
 * Validate the stable envelope and config-editor entries, which are already
 * present in get_config's existing structuredContent.
 */
export const GetConfigOutputSchema = z.object({
  config: z.record(z.unknown()),
  uiHints: z.object({
    availableShells: z.array(z.string()),
  }).strict(),
  entries: z.array(z.object({
    key: z.enum(CONFIG_FIELD_KEYS as [ConfigFieldKey, ...ConfigFieldKey[]]),
    value: z.unknown(),
    valueType: z.enum(['string', 'number', 'boolean', 'array', 'null']),
    editable: z.literal(true),
  }).strict()),
}).strict();
