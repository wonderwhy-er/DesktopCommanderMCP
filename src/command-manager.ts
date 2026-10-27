import path from 'path';
import {configManager} from './config-manager.js';
import {capture} from "./utils/capture.js";
import {getShellType} from './utils/shell.js';
import {readPosixCommands} from './utils/posix-commands.js';
import {readPowerShellCommands} from './utils/powershell-commands.js';
import {readCmdCommands} from './utils/cmd-commands.js';
import type {CommandCheck, CommandReading} from './utils/command-reading.js';

class CommandManager {

    getBaseCommand(command: string) {
        return command.split(' ')[0].toLowerCase().trim();
    }

    /**
     * Reads a command with the grammar of the shell that will run it: POSIX
     * shells (bash, zsh, sh, …), PowerShell, or cmd.
     */
    readCommands(command: string, shell: string): Promise<CommandReading> {
        switch (getShellType(shell)) {
            case 'powershell':
                return readPowerShellCommands(command, shell);
            case 'cmd':
                return readCmdCommands(command);
            default:
                return readPosixCommands(command);
        }
    }

    /**
     * Checks a command against the blockedCommands setting, reading it as the
     * shell that runs it would. Every command the shell would run is found,
     * also on later lines and inside $( ), groups and if bodies, while words
     * inside quotes, heredocs and here-strings stay text. A command is blocked
     * when its program's name, without its folder and lowercased, is in the
     * list. When the settings or the command can't be read, the check fails:
     * a check that couldn't look doesn't let the command run. The one
     * exception is a PowerShell command PowerShell can't parse: PowerShell
     * then runs none of it and answers with its own parse error (&& in
     * Windows PowerShell 5.1), which tells the AI what to fix.
     * `commands` holds the found names (lowercased, folders kept) for telemetry.
     */
    async checkCommand(command: string, shell: string): Promise<CommandCheck> {
        let commands: string[] = [];
        try {
            const config = await configManager.getConfig();
            const blockedCommands = config.blockedCommands || [];

            const reading = await this.readCommands(command, shell);
            if (reading.parseError !== undefined) {
                if (getShellType(shell) === 'powershell') return { verdict: 'allowed', commands };
                return { verdict: 'failed', reason: reading.parseError, commands };
            }

            // A name known only at run time ($tool) names no program the list could match
            const found = reading.commands.filter((cmd) => !cmd.nameAtRunTime);
            commands = [...new Set(found.map((cmd) => cmd.name.toLowerCase()))];
            for (const {name} of found) {
                // A path to the program is matched by its name: /usr/bin/sudo is sudo
                const baseName = path.basename(name).toLowerCase();
                if (blockedCommands.includes(baseName)) {
                    return { verdict: 'blocked', name: baseName, commands };
                }
            }
            return { verdict: 'allowed', commands };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error('Error validating command:', error);
            capture('server_validate_command_error', {
                error: reason
            });
            return { verdict: 'failed', reason, commands };
        }
    }

    /** Whether the command may run: neither blocked nor unreadable (see checkCommand) */
    async validateCommand(command: string, shell: string): Promise<boolean> {
        const check = await this.checkCommand(command, shell);
        return check.verdict !== 'blocked' && check.verdict !== 'failed';
    }
}

export const commandManager = new CommandManager();
