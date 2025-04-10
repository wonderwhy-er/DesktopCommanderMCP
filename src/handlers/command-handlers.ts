import { configManager } from '../config-manager.js';

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
    const command = parsed.command.toLowerCase().trim();
    
    try {
        const config = await configManager.getConfig();
        const blockedCommands = config.blockedCommands || [];
        
        // Check if command is already blocked
        if (blockedCommands.includes(command)) {
            return {
                content: [{ type: "text", text: `Command is already blocked: ${command}` }],
            };
        }
        
        // Add to blocked commands
        const updatedBlockedCommands = [...blockedCommands, command];
        await configManager.setValue('blockedCommands', updatedBlockedCommands);
        
        return {
            content: [{ type: "text", text: `Successfully blocked command: ${command}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Error blocking command: ${errorMessage}` }],
            isError: true
        };
    }
}

/**
 * Handle unblock_command command
 */
export async function handleUnblockCommand(args: unknown): Promise<ServerResult> {
    const parsed = UnblockCommandArgsSchema.parse(args);
    const command = parsed.command.toLowerCase().trim();
    
    try {
        const config = await configManager.getConfig();
        const blockedCommands = config.blockedCommands || [];
        
        // Check if command is blocked
        if (!blockedCommands.includes(command)) {
            return {
                content: [{ type: "text", text: `Command is not blocked: ${command}` }],
            };
        }
        
        // Remove from blocked commands
        const updatedBlockedCommands = blockedCommands.filter(cmd => cmd !== command);
        await configManager.setValue('blockedCommands', updatedBlockedCommands);
        
        return {
            content: [{ type: "text", text: `Successfully unblocked command: ${command}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Error unblocking command: ${errorMessage}` }],
            isError: true
        };
    }
}

/**
 * Handle list_blocked_commands command
 */
export async function handleListBlockedCommands(): Promise<ServerResult> {
    try {
        const config = await configManager.getConfig();
        const blockedCommands = config.blockedCommands || [];
        
        // Create appropriate message based on whether there are blocked commands
        const message = blockedCommands.length > 0
            ? `Blocked commands:\n${blockedCommands.join('\n')}`
            : "No commands are currently blocked.";
        
        return {
            content: [{ type: "text", text: message }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Error listing blocked commands: ${errorMessage}` }],
            isError: true
        };
    }
}