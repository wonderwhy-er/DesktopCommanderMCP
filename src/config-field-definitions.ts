export type ConfigFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'null';

export type ConfigFieldDefinition = {
  label: string;
  description: string;
  valueType: ConfigFieldValueType;
};

// Single source of truth for user-editable configuration fields.
export const CONFIG_FIELD_DEFINITIONS = {
  blockedCommands: {
    label: 'Blocked Commands',
    description: 'This is your personal safety blocklist. If a command appears here, Desktop Commander will refuse to run it even if a prompt asks for it. Add risky commands you never want executed by mistake.',
    valueType: 'array',
  },
  allowedDirectories: {
    label: 'Allowed Folders',
    description: 'These are the folders Desktop Commander is allowed to read and edit. Think of this as a permission list. Keeping it small is safer. If this list is empty, Desktop Commander can access your entire filesystem.',
    valueType: 'array',
  },
  defaultShell: {
    label: 'Default Shell',
    description: 'This is the shell used for new command sessions (for example /bin/bash or /bin/zsh). Only change this if you know your environment requires a specific shell.',
    valueType: 'string',
  },
  telemetryEnabled: {
    label: 'Anonymous Telemetry',
    description: 'When on, Desktop Commander sends anonymous usage information that helps improve product quality. When off, no telemetry data is sent.',
    valueType: 'boolean',
  },
  fileReadLineLimit: {
    label: 'File Read Limit',
    description: 'Maximum number of lines returned from a file in one read action. Lower numbers keep responses short and safer; higher numbers return more text at once.',
    valueType: 'number',
  },
  fileWriteLineLimit: {
    label: 'File Write Limit',
    description: 'Maximum number of lines that can be written in one edit operation. This helps prevent accidental oversized writes and keeps file changes predictable.',
    valueType: 'number',
  },
} as const satisfies Record<string, ConfigFieldDefinition>;

export type ConfigFieldKey = keyof typeof CONFIG_FIELD_DEFINITIONS;

export const CONFIG_FIELD_KEYS = Object.keys(CONFIG_FIELD_DEFINITIONS) as ConfigFieldKey[];

export function isConfigFieldKey(value: string): value is ConfigFieldKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_FIELD_DEFINITIONS, value);
}
