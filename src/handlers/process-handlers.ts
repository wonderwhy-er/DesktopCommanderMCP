import { 
    listProcesses,
    killProcess
} from '../tools/process.js';

import { 
    KillProcessArgsSchema
} from '../tools/schemas.js';

/**
 * Handle list_processes command
 */
export async function handleListProcesses() {
    return listProcesses();
}

/**
 * Handle kill_process command
 */
export async function handleKillProcess(args: unknown) {
    const parsed = KillProcessArgsSchema.parse(args);
    return killProcess(parsed);
}
