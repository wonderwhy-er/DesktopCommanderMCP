/** Read broker for the frozen review folder. No model-provided command reaches a shell. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LIMIT = 20_000;
const COMMAND = /^(git (log|show|rev-parse|merge-base)|gh (pr|run) view)( [\w.,:/^~=@%+-]+)*$/;
const REFUSED = /^--(output|ext-diff|textconv|repo|web|exec-path|git-dir|work-tree)(=|$)|^-[ORw]/;
const GIT_OPTION =
  /^(--|-[0-9]+|-[pmsq]|--(format|pretty|oneline|stat|name-only|name-status|numstat|parents|no-patch|patch|no-color|no-decorate|no-walk|reverse|abbrev-commit|date|since|until|max-count|first-parent|is-ancestor|verify|short|all|boundary|left-right|full-history|topo-order|raw|quiet|no-ext-diff|no-textconv|end-of-options)(=[\w.,:/^~=@%+-]+)?)$/;

function inside(folder, given) {
  if (typeof given !== 'string' || path.isAbsolute(given) || given.includes('\\')) throw new Error('Path denied.');
  if (!/^(pr|review)(\/|$)/.test(given)) throw new Error('Only pr/ and review/ may be read.');
  const root = fs.realpathSync(folder);
  const file = fs.realpathSync(path.resolve(root, given));
  if (!file.startsWith(`${root}${path.sep}`) || !/^(pr|review)(\\|\/|$)/.test(path.relative(root, file)))
    throw new Error('Path denied.');
  return file;
}

function filesUnder(folder, dir, found = []) {
  for (const entry of fs.readdirSync(inside(folder, dir), { withFileTypes: true })) {
    if (found.length >= 10_000) break;
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) filesUnder(folder, file, found);
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

function globPattern(pattern) {
  const parts = String(pattern).split('**');
  const literal = part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '[^/]*').replaceAll('?', '[^/]');
  let expression = literal(parts[0]);
  for (let at = 1; at < parts.length; at++) {
    const part = parts[at];
    const before = parts[at - 1];
    // Only a whole **/ component can skip directories; embedded stars retain their prior behavior.
    const directory = part.startsWith('/') && ((at === 1 && before === '') || before.endsWith('/'));
    expression += directory ? `(?:[^/]+/)*${literal(part.slice(1))}` : `.*${literal(part)}`;
  }
  return new RegExp(`^${expression}$`);
}

function githubArguments(words) {
  const options = words.slice(2);
  if (options[0] && !options[0].startsWith('-')) {
    if (!/^\d+$/.test(options.shift())) return false;
  }
  while (options.length) {
    const [flag, given] = options.shift().split('=');
    if (['--comments', '-c', '--log', '--log-failed', '--exit-status'].includes(flag) && given === undefined) continue;
    const value = given ?? options.shift();
    if (typeof value !== 'string') return false;
    if (flag === '--json' && /^[A-Za-z,]+$/.test(value)) continue;
    if (['--jq', '-q'].includes(flag) && /^[\w.,]+$/.test(value)) continue;
    if (['--job', '-j', '--attempt'].includes(flag) && /^\d+$/.test(value)) continue;
    return false;
  }
  return true;
}

export function allowedRead(command) {
  const words = String(command).trim().split(' ');
  if (!COMMAND.test(command) || words.some((word) => REFUSED.test(word))) return false;
  if (words[0] === 'gh') return githubArguments(words.slice(1));
  return !words.slice(1).some((word) => (word.startsWith('-') && !GIT_OPTION.test(word)) || word.includes('%G'));
}

export function toolEnvironment({ executable, folder, gitDir, repo, token, environment = process.env }) {
  // Only the system paths needed to start git/gh. No API key or unrelated secret is inherited.
  const env = Object.fromEntries(
    [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'PATHEXT',
      'TMP',
      'TEMP',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'XDG_CONFIG_HOME',
    ]
      .filter((name) => environment[name])
      .map((name) => [name, environment[name]]),
  );
  Object.assign(env, {
    GIT_PAGER: 'cat',
    GH_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0',
  });
  if (executable === 'git') {
    env.GIT_DIR = gitDir;
    env.GIT_WORK_TREE = path.join(folder, 'pr');
  } else {
    env.GH_REPO = repo;
    if (token) env.GH_TOKEN = token;
  }
  return env;
}

function shellRead({ args, folder, shell, gitDir, repo, token, timeoutMs }) {
  const command = String(args.command ?? '').trim();
  const words = command.split(' ');
  if (!shell || !allowedRead(command)) return 'Tool denied: only plain read-only git/gh commands in this repository.';
  const executable = words.shift();
  if (executable === 'gh' && !repo) return 'Tool denied: no GitHub repository.';
  const env = toolEnvironment({ executable, folder, gitDir, repo, token });
  if (executable === 'git') {
    if (['log', 'show'].includes(words[0])) words.splice(1, 0, '--no-ext-diff', '--no-textconv', '--no-show-signature');
    words.unshift('-c', 'diff.external=', '-c', 'core.pager=cat');
  }
  const done = spawnSync(executable, words, {
    cwd: folder,
    env,
    encoding: 'utf8',
    shell: false,
    timeout: Math.min(30_000, timeoutMs ?? 30_000),
    maxBuffer: 2 * 1024 * 1024,
  });
  return done.status === 0 ? done.stdout : `Read failed: ${done.error?.message ?? done.stderr}`;
}

export async function readTool(options) {
  const { folder, name, args = {} } = options;
  try {
    let toolText;
    if (name === 'run_shell_command') toolText = shellRead(options);
    else if (name === 'read_file') {
      const file = inside(folder, args.path);
      if (fs.statSync(file).size > 2 * 1024 * 1024) return 'Read denied: file exceeds 2 MiB.';
      const start = Math.max(1, Number(args.start_line) || 1);
      const end = Math.min(start + 499, Number(args.end_line) || start + 499);
      toolText = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .slice(start - 1, end)
        .map((line, at) => `${start + at}: ${line}`)
        .join('\n');
    } else if (name === 'list_directory') toolText = fs.readdirSync(inside(folder, args.path ?? 'pr')).join('\n');
    else if (name === 'glob' || name === 'grep_search') {
      const files = filesUnder(folder, args.path ?? 'pr');
      if (name === 'glob') toolText = files.filter((file) => globPattern(args.pattern ?? '**').test(file)).join('\n');
      else {
        const rows = [];
        let bytes = 0;
        for (const file of files) {
          const full = inside(folder, file);
          const size = fs.statSync(full).size;
          if (size > 2 * 1024 * 1024) continue;
          bytes += size;
          if (bytes > 4 * 1024 * 1024) break;
          fs.readFileSync(full, 'utf8')
            .split('\n')
            .forEach((line, at) => {
              if (rows.length < 200 && line.includes(String(args.pattern ?? '')))
                rows.push(`${file}:${at + 1}: ${line}`);
            });
          if (rows.length >= 200) break;
        }
        toolText = rows.join('\n');
      }
    } else toolText = 'Tool denied: unknown or write-capable tool.';
    return String(toolText).slice(0, LIMIT);
  } catch (error) {
    return `Read denied: ${error.message}`.slice(0, LIMIT);
  }
}

export function readTools(shell) {
  const tool = (name, description, properties, required) => ({
    type: 'function',
    name,
    description,
    strict: false,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  });
  const string = { type: 'string' };
  const tools = [
    tool(
      'read_file',
      'Read up to 500 numbered lines of a frozen file under pr/ or review/.',
      { path: string, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
      ['path'],
    ),
    tool('list_directory', 'List names under pr/ or review/.', { path: string }, ['path']),
    tool('glob', 'Find frozen files using * and ** in a path pattern.', { path: string, pattern: string }, ['pattern']),
    tool(
      'grep_search',
      'Find a literal string in frozen files, up to 200 numbered matching lines.',
      { path: string, pattern: string },
      ['pattern'],
    ),
  ];
  if (shell)
    tools.push(
      tool(
        'run_shell_command',
        'Read this repository using plain git log/show/rev-parse/merge-base or gh pr/run view. No shell syntax or writes.',
        { command: string },
        ['command'],
      ),
    );
  return tools;
}
