import { commandManager } from '../command-manager.js';

import { 
    BlockCommandArgsSchema,
    UnblockCommandArgsSchema
} from '../tools/schemas.js';

/**
 * Handle block_command command
 */
export async function handleBlockCommand(args: unknown) {
    const parsed = BlockCommandArgsSchema.parse(args);
    const blockResult = await commandManager.blockCommand(parsed.command);
    return {
        content: [{ type: "text", text: blockResult }],
    };
}

/**
 * Handle unblock_command command
 */
export async function handleUnblockCommand(args: unknown) {
    const parsed = UnblockCommandArgsSchema.parse(args);
    const unblockResult = await commandManager.unblockCommand(parsed.command);
    return {
        content: [{ type: "text", text: unblockResult }],
    };
}

/**
 * Handle list_blocked_commands command
 */
export async function handleListBlockedCommands() {
    const blockedCommands = commandManager.listBlockedCommands();
    return {
        content: [{ type: "text", text: blockedCommands.join('\n') }],
    };
}
