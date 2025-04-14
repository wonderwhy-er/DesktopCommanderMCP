import { commandManager } from '../command-manager.js';

import { 
    BlockCommandArgsSchema,
    UnblockCommandArgsSchema
} from '../tools/schemas.js';

import { ServerResult } from '../types.js';

/**
 * Handle block_command command
 */
export async function handleBlockCommand(args: unknown): Promise<ServerResult> {
    const parsed = BlockCommandArgsSchema.parse(args);
    const blockResult = await commandManager.blockCommand(parsed.command);
    
    // Convert boolean result to appropriate message string
    const message = blockResult 
        ? `Successfully blocked command: ${parsed.command}`
        : `Command is already blocked: ${parsed.command}`;
    
    return {
        content: [{ type: "text", text: message }],
    };
}

/**
 * Handle unblock_command command
 */
export async function handleUnblockCommand(args: unknown): Promise<ServerResult> {
    const parsed = UnblockCommandArgsSchema.parse(args);
    const unblockResult = await commandManager.unblockCommand(parsed.command);
    
    // Convert boolean result to appropriate message string
    const message = unblockResult 
        ? `Successfully unblocked command: ${parsed.command}`
        : `Command is not blocked or doesn't exist: ${parsed.command}`;
    
    return {
        content: [{ type: "text", text: message }],
    };
}

/**
 * Handle list_blocked_commands command
 */
export function handleListBlockedCommands(): ServerResult {
    const blockedCommands = commandManager.listBlockedCommands();
    
    // Create appropriate message based on whether there are blocked commands
    const message = blockedCommands.length > 0
        ? `Blocked commands:\n${blockedCommands.join('\n')}`
        : "No commands are currently blocked.";
    
    return {
        content: [{ type: "text", text: message }],
    };
}