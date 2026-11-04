import { getShellType, POSIX_SHELLS } from './shell.js';

type FileWord = string | null;

const POSIX_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const BASH_STARTUP_OPTIONS = new Set(['--rcfile', '--init-file']);
// Minimum spellings and aliases follow the PowerShell host's option precedence.
const POWERSHELL_VALUE_OPTIONS = [
    ['-executionpolicy', '-ex'], ['-inputformat', '-inp'], ['-outputformat', '-o'],
    ['-configurationname', '-config'], ['-configurationfile', '-configurationfile'],
    ['-custompipename', '-cus'], ['-workingdirectory', '-wo'], ['-settingsfile', '-settings'],
    ['-windowstyle', '-w'], ['-encodedarguments', '-encodeda'],
];
const POWERSHELL_VALUE_ALIASES = new Set(['-ep', '-if', '-of', '-wd', '-ea']);

function posixValueOption(arg: string): boolean {
    return POSIX_VALUE_OPTIONS.has(arg) || /^[-+][a-zA-Z]*[oO]/.test(arg);
}

function posixScriptFile(args: FileWord[]): FileWord | undefined {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === null) return arg;
        if (/^-[a-zA-Z]*[cs]/.test(arg) || arg === '--command') return undefined;
        if (posixValueOption(arg)) {
            i++;
            continue;
        }
        if (!arg.startsWith('-') && !arg.startsWith('+')) return arg;
    }
    return undefined;
}

function bashStartupFile(args: FileWord[]): FileWord | undefined {
    let file: FileWord | undefined;
    let interactive = false;
    let login = false;
    let noRc = false;
    let posix = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === null || arg === '--') break;
        if (BASH_STARTUP_OPTIONS.has(arg)) {
            file = args[++i];
            continue;
        }
        if (arg === '--norc') noRc = true;
        if (arg === '--login') login = true;
        if (arg === '--posix') posix = true;
        if (/^[-+][a-zA-Z]+$/.test(arg)) {
            if (arg.includes('i')) interactive = arg[0] === '-';
            if (arg.includes('l')) login = arg[0] === '-';
        }
        if (posixValueOption(arg)) {
            if (args[++i] === 'posix' && /^[-+][a-zA-Z]*o/.test(arg)) posix = arg[0] === '-';
            continue;
        }
        if (!arg.startsWith('-') && !arg.startsWith('+')) break;
    }
    // Bash reads the custom rcfile only in interactive, non-login Bash mode.
    if (!interactive || login || noRc || posix || file === '') return undefined;
    return file;
}

function powershellScriptFile(program: string, args: FileWord[]): FileWord | undefined {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === null) return arg;
        const option = arg.toLowerCase();
        if (arg === '-' || arg === '') return undefined;
        if ('-command'.startsWith(option) || ['-commandwithargs', '-cwa', '-ec'].includes(option)
            || '-encodedcommand'.startsWith(option)) return undefined;
        if (['-f', '-fi', '-fil', '-file'].includes(option)) {
            return args[i + 1] === '-' ? undefined : args[i + 1];
        }
        if (['-version', '-v'].includes(option)) {
            if (program === 'pwsh' || program === 'pwsh.exe') return undefined;
            i++;
            continue;
        }
        if (POWERSHELL_VALUE_ALIASES.has(option) || POWERSHELL_VALUE_OPTIONS.some(
            ([name, minimum]) => option.length >= minimum.length && name.startsWith(option),
        )) {
            i++;
            continue;
        }
        if (!arg.startsWith('-')) return arg;
    }
    return undefined;
}

/** File arguments are found before command/script arguments can be mistaken for more host options. */
export function shellScriptFiles(program: string, args: FileWord[]): FileWord[] {
    if (POSIX_SHELLS.has(program)) {
        const files: FileWord[] = [];
        const startup = program === 'bash' ? bashStartupFile(args) : undefined;
        const script = posixScriptFile(args);
        if (startup !== undefined) files.push(startup);
        if (script !== undefined) files.push(script);
        return files;
    }
    if (getShellType(program) === 'powershell') {
        const script = powershellScriptFile(program, args);
        if (script !== undefined) return [script];
    }
    return [];
}
