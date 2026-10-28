import path from 'path';
import {configManager} from './config-manager.js';
import {capture} from "./utils/capture.js";
import {getShellType, isShellAvailable, POSIX_SHELLS, programName, type ShellType} from './utils/shell.js';
import {readPosixCommands} from './utils/posix-commands.js';
import {readPowerShellCommands} from './utils/powershell-commands.js';
import {readCmdCommands} from './utils/cmd-commands.js';
import {withStartedPrograms} from './utils/command-wrappers.js';
import type {CommandReading, FoundCommand} from './utils/command-reading.js';

/**
 * The check's answer for one command.
 * - allowed: no blocked program runs.
 * - blocked: `name` is the blockedCommands entry that one of the programs matched.
 * - unseen: allowed, but some program is chosen only when the command runs
 *   (eval "$CMD", Invoke-Expression $cmd, & $tool) or is in a script file
 *   (bash deploy.sh). Each entry of `unseen` says what hides one of them.
 * - failed: the check couldn't read the command or the settings, and
 *   `reason` holds the error's message.
 */
export type CommandCheck =
  | { verdict: 'allowed' }
  | { verdict: 'blocked'; name: string }
  | { verdict: 'unseen'; unseen: UnseenProgram[] }
  | { verdict: 'failed'; reason: string };

/** Something in a command that hides the program it runs from the check */
export interface UnseenProgram {
  /** What hides it, as the shell reads it (in PowerShell, an alias's target): "eval", "Invoke-Expression", "$tool" or "deploy.sh" */
  what: string;
  /** True for a script file (bash deploy.sh), false for a program chosen at run time (eval, Invoke-Expression, $tool) */
  inFile: boolean;
}

// POSIX shell options that take the next word as their value, so it isn't the script file
const POSIX_SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

class CommandManager {

    getBaseCommand(command: string) {
        return command.split(' ')[0].toLowerCase().trim();
    }

    /**
     * The command name of each command in a command line (chained, piped, in $(), ...).
     * asTyped: each first word as typed instead of its base name, for telemetry,
     * which then replaces a path whole (a base name alone can't be told from one).
     */
    extractCommands(commandString: string, asTyped = false): string[] {
        try {
            // Trim any leading/trailing whitespace
            commandString = commandString.trim();

            // Define command separators - these are the operators that can chain commands
            const separators = [';', '&&', '||', '|', '&'];

            // This will store our extracted commands
            const commands: string[] = [];

            // Split by common separators while preserving quotes
            let inQuote = false;
            let quoteChar = '';
            let currentCmd = '';
            let escaped = false;

            for (let i = 0; i < commandString.length; i++) {
                const char = commandString[i];

                // Handle escape characters
                if (char === '\\' && !escaped) {
                    escaped = true;
                    currentCmd += char;
                    continue;
                }

                // If this character is escaped, just add it
                if (escaped) {
                    escaped = false;
                    currentCmd += char;
                    continue;
                }

                // Handle quotes (both single and double)
                if ((char === '"' || char === "'") && !inQuote) {
                    inQuote = true;
                    quoteChar = char;
                    currentCmd += char;
                    continue;
                } else if (char === quoteChar && inQuote) {
                    inQuote = false;
                    quoteChar = '';
                    currentCmd += char;
                    continue;
                }

                // Handle $() command substitution even inside quotes (fixes blocklist bypass)
                if (char === '$' && i + 1 < commandString.length && commandString[i + 1] === '(') {
                    const startIndex = i;
                    let openParens = 1;
                    let j = i + 2; // skip past $(
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }
                    if (j <= commandString.length && openParens === 0) {
                        const subContent = commandString.substring(i + 2, j - 1);
                        const subCommands = this.extractCommands(subContent, asTyped);
                        commands.push(...subCommands);
                        i = j - 1;
                        if (!inQuote) {
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j);
                            continue;
                        }
                    }
                }

                // Handle backtick command substitution even inside quotes
                if (char === '`') {
                    const startIndex = i;
                    let j = i + 1;
                    while (j < commandString.length && commandString[j] !== '`') {
                        j++;
                    }
                    if (j < commandString.length) {
                        const subContent = commandString.substring(i + 1, j);
                        const subCommands = this.extractCommands(subContent, asTyped);
                        commands.push(...subCommands);
                        i = j;
                        if (!inQuote) {
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j + 1);
                            continue;
                        }
                    }
                }

                // If we're inside quotes, just add the character
                if (inQuote) {
                    currentCmd += char;
                    continue;
                }

                // Handle subshells - if we see an opening parenthesis, we need to find its matching closing parenthesis
                if (char === '(') {
                    // Find the matching closing parenthesis
                    let openParens = 1;
                    let j = i + 1;
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }

                    // Skip to after the closing parenthesis only if properly balanced
                    if (j <= commandString.length && openParens === 0) {
                        const subshellContent = commandString.substring(i + 1, j - 1);
                        // Recursively extract commands from the subshell
                        const subCommands = this.extractCommands(subshellContent, asTyped);
                        commands.push(...subCommands);

                        // Move position past the subshell
                        i = j - 1;
                        continue;
                    }
                }

                // Check for separators
                let isSeparator = false;
                for (const separator of separators) {
                    if (commandString.startsWith(separator, i)) {
                        // We found a separator - extract the command before it
                        if (currentCmd.trim()) {
                            const baseCommand = this.extractBaseCommand(currentCmd.trim(), asTyped);
                            if (baseCommand) commands.push(baseCommand);
                        }

                        // Move past the separator
                        i += separator.length - 1;
                        currentCmd = '';
                        isSeparator = true;
                        break;
                    }
                }

                if (!isSeparator) {
                    currentCmd += char;
                }
            }

            // Don't forget to add the last command
            if (currentCmd.trim()) {
                const baseCommand = this.extractBaseCommand(currentCmd.trim(), asTyped);
                if (baseCommand) commands.push(baseCommand);
            }

            // Remove duplicates and return
            return [...new Set(commands)];
        } catch (error) {
            // If anything goes wrong, log the error but return the basic command to not break execution
            capture('server_request_error', {
                error: 'Error extracting commands'
            });
            const baseCmd = this.extractBaseCommand(commandString, asTyped);
            return baseCmd ? [baseCmd] : [];
        }
    }

    // This extracts the actual command name from a command string (asTyped: see extractCommands)
    extractBaseCommand(commandStr: string, asTyped = false): string | null {
        try {
            // Remove environment variables (patterns like KEY=value)
            const withoutEnvVars = commandStr.replace(/\w+=\S+\s*/g, '').trim();

            // If nothing remains after removing env vars, return null
            if (!withoutEnvVars) return null;

            // Get the first token (the command)
            const tokens = withoutEnvVars.split(/\s+/);
            let firstToken = null;

            // Find the first valid token (skip variables)
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                
                // Skip dollar-prefixed tokens (variables) but not $() command substitutions
                if (token.startsWith('$') && !token.startsWith('$(')) {
                    continue;
                }
                
                // Check if it starts with special characters like ( that might indicate it's not a regular command
                if (token[0] === '(') {
                    continue;
                }
                
                firstToken = token;
                break;
            }

            // No valid command token found
            if (!firstToken) {
                return null;
            }

            // handle $() command substitution - extract the inner command
            if (firstToken.startsWith('$(') && firstToken.endsWith(')')) {
                const inner = firstToken.slice(2, -1).trim();
                if (inner) {
                    const innerTokens = inner.split(/\s+/);
                    return (asTyped ? innerTokens[0] : path.basename(innerTokens[0])).toLowerCase();
                }
                return null;
            }

            // strip path prefix so /usr/bin/sudo gets caught as "sudo"
            const baseName = asTyped ? firstToken : path.basename(firstToken);
            return baseName.toLowerCase();
        } catch (error) {
            capture('Error extracting base command');
            return null;
        }
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
     * The commands of a reading that run a program: the calls to the script's
     * own functions are left out. A script can define a function with a
     * program's name, such as an error helper named halt, and the shell then
     * runs the function, not the program. A call is the function's when it
     * comes after the definition, its name as written has no folder
     * (/sbin/halt is the program), and the reader lists the function, so not
     * one the text may remove. PowerShell finds a function whatever the case
     * of its name, POSIX shells only by its exact name. The function's body is
     * read as commands of its own, so a blocked program inside it is still
     * found.
     */
    private withoutOwnFunctionCalls(reading: CommandReading, shellType: ShellType): FoundCommand[] {
        const sameName = (a: string, b: string) => shellType === 'powershell' ? a.toLowerCase() === b.toLowerCase() : a === b;
        return reading.commands.filter((cmd) => {
            const written = cmd.words[0];
            if (written === null || written.includes('/') || written.includes('\\')) return true;
            return !reading.functions.some((fn) => sameName(fn.name, written) && cmd.start >= fn.end);
        });
    }

    /**
     * What hides a program from the check among the commands that run
     * (CommandCheck's `unseen`), in the order the commands start:
     * - a program chosen only when the command runs: a name that is a variable
     *   or another command's output (& $tool), or eval and Invoke-Expression,
     *   which run text the command builds (eval "$CMD");
     * - a script file given to a shell (bash deploy.sh): the commands in it
     *   aren't in the text. A file named only when the command runs ("$SCRIPT")
     *   counts as a program chosen at run time, named by the shell.
     */
    private findUnseen(commands: FoundCommand[], shellType: ShellType): UnseenProgram[] {
        const unseen: UnseenProgram[] = [];
        for (const cmd of commands) {
            if (cmd.nameAtRunTime) {
                unseen.push({ what: cmd.name, inFile: false });
                continue;
            }
            const program = programName(cmd.name);
            const runsText = (shellType === 'posix' && program === 'eval')
                || (shellType === 'powershell' && program === 'invoke-expression');
            if (runsText) {
                unseen.push({ what: cmd.name, inFile: false });
                continue;
            }
            const fromFile = this.scriptFile(cmd, shellType);
            if (fromFile) unseen.push(fromFile);
        }
        return unseen;
    }

    /**
     * What hides the program when a command gives a shell a script file to run
     * (bash deploy.sh, pwsh -File deploy.ps1, source deploy.sh), or when
     * PowerShell runs one named as the command (./deploy.ps1): the file, or the
     * shell when the file is named only when the command runs ("$SCRIPT").
     * Undefined when the command runs no script file: a shell given its
     * commands as text (bash -c '…') or reading its input.
     */
    private scriptFile(cmd: FoundCommand, shellType: ShellType): UnseenProgram | undefined {
        const program = programName(cmd.name);
        const args = cmd.words.slice(1);
        const hidden = (file: string | null | undefined): UnseenProgram | undefined => {
            if (file === undefined) return undefined;
            return file === null ? { what: cmd.name, inFile: false } : { what: file, inFile: true };
        };
        if (shellType === 'posix' && (program === 'source' || program === '.')) {
            return hidden(args[0]);
        }
        // PowerShell runs a .ps1 named as the command (./deploy.ps1, & ./deploy.ps1) as a script file
        if (shellType === 'powershell' && /\.ps1$/i.test(cmd.name)) {
            return hidden(cmd.name);
        }
        if (POSIX_SHELLS.has(program)) {
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === null) return hidden(arg);
                // -c (fish: --command) takes the commands as text, -s reads them from the input (also in -lc, -ec, ...)
                if (/^-[a-zA-Z]*[cs]/.test(arg) || arg === '--command') return undefined;
                if (POSIX_SHELL_VALUE_OPTIONS.has(arg)) {
                    i++;
                    continue;
                }
                if (arg.startsWith('-') || arg.startsWith('+')) continue;
                return hidden(arg);
            }
            return undefined;
        }
        if (getShellType(program) === 'powershell') {
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === null) continue;
                // -File, or any start of it PowerShell accepts
                if (['-f', '-fi', '-fil', '-file'].includes(arg.toLowerCase())) return hidden(args[i + 1]);
                if (/\.ps1$/i.test(arg)) return hidden(arg);
            }
        }
        return undefined;
    }

    /**
     * The check's answer for `command` run by `shell`:
     * - allowed: no program it runs is blocked.
     * - blocked: a program it runs is in blockedCommands, both compared in the
     *   form programName() gives; the answer names the entry as written (a call
     *   to the script's own function is not the program: see withoutOwnFunctionCalls).
     *   A program a wrapper starts is one it runs: env sudo ls runs sudo.
     * - unseen: allowed, but a program is chosen only when the command runs or
     *   is in a script file (see findUnseen), so start_process can say the
     *   blocklist couldn't check it.
     * - failed: the command or the settings can't be read. In PowerShell a parse
     *   error or a missing PowerShell is allowed instead: nothing runs, and
     *   PowerShell or start_process answers.
     */
    async checkCommand(command: string, shell: string): Promise<CommandCheck> {
        try {
            const config = await configManager.getConfig();
            const blockedCommands = config.blockedCommands || [];

            const shellType = getShellType(shell);
            // PowerShell runs nothing when it isn't there or can't parse the command: it, or start_process, answers
            if (shellType === 'powershell' && !isShellAvailable(shell)) return { verdict: 'allowed' };
            const reading = await this.readCommands(command, shell);
            // A parse error is the command's fault, not the server's, so it isn't logged or sent
            if (reading.parseError !== undefined) {
                return shellType === 'powershell'
                    ? { verdict: 'allowed' }
                    : { verdict: 'failed', reason: reading.parseError };
            }

            // A wrapper starts the program itself, never the script's own function of that name
            const running = withStartedPrograms(this.withoutOwnFunctionCalls(reading, shellType), shellType);
            // set_config_value checks only that the list is an array
            const entries = blockedCommands.filter((entry): entry is string => typeof entry === 'string');
            for (const found of running) {
                // A name known only at run time ($tool) names no program the list could match
                if (found.nameAtRunTime) continue;
                const program = programName(found.name);
                const entry = entries.find((entry) => programName(entry) === program);
                if (entry !== undefined) return { verdict: 'blocked', name: entry };
            }
            const unseen = this.findUnseen(running, shellType);
            return unseen.length > 0 ? { verdict: 'unseen', unseen } : { verdict: 'allowed' };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error('Error validating command:', error);
            capture('server_validate_command_error', {
                error: reason
            });
            // Fail closed: deny the command if validation encounters an error.
            // This prevents a config read failure from bypassing all command filtering.
            return { verdict: 'failed', reason };
        }
    }

    /** Whether a check's answer refuses the command */
    isRefused(check: CommandCheck): check is Extract<CommandCheck, { verdict: 'blocked' | 'failed' }> {
        return check.verdict === 'blocked' || check.verdict === 'failed';
    }

    /** Whether the command may run in `shell`: the check doesn't refuse it */
    async validateCommand(command: string, shell: string): Promise<boolean> {
        return !this.isRefused(await this.checkCommand(command, shell));
    }
}

export const commandManager = new CommandManager();
