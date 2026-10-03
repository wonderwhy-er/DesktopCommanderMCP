import path from 'path';
import {configManager} from './config-manager.js';
import {capture} from "./utils/capture.js";

// Thrown when nested $()/backtick/subshell parsing exceeds the depth limit.
// Must propagate past extractCommands' own catch (rather than being swallowed
// into a "no dangerous commands found" result) so validateCommand's fail-closed
// handling denies the command instead of accidentally allowing it through.
class CommandParsingLimitError extends Error {}

const MAX_RECURSION_DEPTH = 20;

// Matches a leading environment variable assignment, e.g. FOO=bar or FOO=
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Splits a command string into whitespace-separated tokens, keeping quoted
// segments (which may contain spaces, e.g. VAR="a b") intact as one token.
function tokenizeRespectingQuotes(str: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    let escaped = false;

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];

        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            current += ch;
            continue;
        }
        if ((ch === '"' || ch === "'") && (!inQuote || ch === quoteChar)) {
            inQuote = !inQuote;
            quoteChar = inQuote ? ch : '';
            current += ch;
            continue;
        }
        if (!inQuote && /\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
}

class CommandManager {

    getBaseCommand(command: string) {
        return command.split(' ')[0].toLowerCase().trim();
    }

    extractCommands(commandString: string, depth: number = 0): string[] {
        if (depth > MAX_RECURSION_DEPTH) {
            capture('command_parser_depth_exceeded', { depth });
            throw new CommandParsingLimitError('Command nesting depth exceeded maximum allowed limit');
        }
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
                    let parenEscaped = false;
                    while (j < commandString.length && openParens > 0) {
                        const pc = commandString[j];
                        if (parenEscaped) { parenEscaped = false; j++; continue; }
                        if (pc === '\\') { parenEscaped = true; j++; continue; }
                        if (pc === '(') openParens++;
                        if (pc === ')') openParens--;
                        j++;
                    }
                    if (j <= commandString.length && openParens === 0) {
                        const subContent = commandString.substring(i + 2, j - 1);
                        const subCommands = this.extractCommands(subContent, depth + 1);
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
                    let backtickEscaped = false;
                    while (j < commandString.length) {
                        const bc = commandString[j];
                        if (backtickEscaped) { backtickEscaped = false; j++; continue; }
                        if (bc === '\\') { backtickEscaped = true; j++; continue; }
                        if (bc === '`') break;
                        j++;
                    }
                    if (j < commandString.length) {
                        const subContent = commandString.substring(i + 1, j);
                        const subCommands = this.extractCommands(subContent, depth + 1);
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
                    let subshellEscaped = false;
                    while (j < commandString.length && openParens > 0) {
                        const sc = commandString[j];
                        if (subshellEscaped) { subshellEscaped = false; j++; continue; }
                        if (sc === '\\') { subshellEscaped = true; j++; continue; }
                        if (sc === '(') openParens++;
                        if (sc === ')') openParens--;
                        j++;
                    }

                    // Skip to after the closing parenthesis only if properly balanced
                    if (j <= commandString.length && openParens === 0) {
                        const subshellContent = commandString.substring(i + 1, j - 1);
                        // Recursively extract commands from the subshell
                        const subCommands = this.extractCommands(subshellContent, depth + 1);
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
                            const baseCommand = this.extractBaseCommand(currentCmd.trim());
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
                const baseCommand = this.extractBaseCommand(currentCmd.trim());
                if (baseCommand) commands.push(baseCommand);
            }

            // Remove duplicates and return
            return [...new Set(commands)];
        } catch (error) {
            // Depth-limit errors must propagate to validateCommand's fail-closed
            // handling, not be swallowed into a seemingly-safe fallback result.
            if (error instanceof CommandParsingLimitError) {
                throw error;
            }
            // For genuine unexpected parse errors, log and fall back to the basic
            // command so a malformed-but-benign input doesn't break execution.
            capture('server_request_error', {
                error: 'Error extracting commands'
            });
            const baseCmd = this.extractBaseCommand(commandString);
            return baseCmd ? [baseCmd] : [];
        }
    }

    // This extracts the actual command name from a command string
    extractBaseCommand(commandStr: string): string | null {
        try {
            // Strip leading environment variable assignments (KEY=value, including
            // quoted values with spaces like KEY="a b") and 'export' prefixes, so
            // e.g. "export PATH=/x rm -rf /" resolves to "rm", not "export".
            const tokens = tokenizeRespectingQuotes(commandStr.trim());
            let startIdx = 0;
            while (startIdx < tokens.length) {
                const token = tokens[startIdx];
                if (token === 'export') {
                    startIdx++;
                    continue;
                }
                if (ENV_ASSIGNMENT_PATTERN.test(token)) {
                    startIdx++;
                    continue;
                }
                break;
            }

            // If nothing remains after removing env vars, return null
            if (startIdx >= tokens.length) return null;

            let firstToken = null;

            // Find the first valid token (skip variables)
            for (let i = startIdx; i < tokens.length; i++) {
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
                    return path.basename(innerTokens[0]).toLowerCase();
                }
                return null;
            }

            // strip path prefix so /usr/bin/sudo gets caught as "sudo"
            const baseName = path.basename(firstToken);
            return baseName.toLowerCase();
        } catch (error) {
            capture('Error extracting base command');
            return null;
        }
    }

    async validateCommand(command: string): Promise<boolean> {
        try {
            // Get blocked commands from config
            const config = await configManager.getConfig();
            const blockedCommands = config.blockedCommands || [];
            
            // Extract all commands from the command string
            const allCommands = this.extractCommands(command);
            
            // If there are no commands extracted, fall back to base command
            if (allCommands.length === 0) {
                const baseCommand = this.getBaseCommand(command);
                return !blockedCommands.includes(baseCommand);
            }
            
            // Check if any of the extracted commands are in the blocked list
            for (const cmd of allCommands) {
                if (blockedCommands.includes(cmd)) {
                    return false; // Command is blocked
                }
            }
            
            // No commands were blocked
            return true;
        } catch (error) {
            console.error('Error validating command:', error);
            capture('server_validate_command_error', {
                error: error instanceof Error ? error.message : String(error)
            });
            // Fail closed: deny the command if validation encounters an error.
            // This prevents a config read failure from bypassing all command filtering.
            return false;
        }
    }
}

export const commandManager = new CommandManager();
