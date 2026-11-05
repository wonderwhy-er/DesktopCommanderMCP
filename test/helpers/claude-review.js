/** Claude Code API-key runner. The existing read broker stays outside the model process. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readTool, readTools } from './review-tools.js';
import { CREDENTIAL } from './review-context.js';

export const CLAUDE_MODEL = 'claude-haiku-5-5';
export const CLAUDE_VERSION = '2.1.293';
const PRIVATE_KEY_BLOCK = new RegExp('-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
  + '[\\s\\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)', 'g');

function childEnvironment(environment, key, home) {
  const names = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TMP', 'TEMP'];
  return {
    ...Object.fromEntries(names.filter((name) => environment[name]).map((name) => [name, environment[name]])),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_API_KEY: key,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '0',
    CI: 'true',
  };
}

function runCli(cli, args, options, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const script = /\.m?js$/i.test(cli);
    const child = spawn(script ? process.execPath : cli, script ? [cli, ...args] : args, {
      ...options,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let stopped = false;
    child.stdout.on('data', (part) => {
      stdout += stdoutDecoder.write(part);
      stdoutBytes += part.length;
      if (stdoutBytes > 4 * 1024 * 1024) { stopped = true; child.kill(); }
    });
    // Drain stderr fully, but retain only a bounded diagnostic for credential redaction by the caller.
    child.stderr.on('data', (part) => { stderr = (stderr + part).slice(0, 20_000); });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Claude Code could not start.')); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal || stopped) reject(new Error('Claude Code timeout or output limit: review not done.'));
      else resolve({ code, stdout: stdout + stdoutDecoder.end(), stderr });
    });
    child.stdin.end(input);
  });
}

export async function askClaude({ prompt, key, folder, out, calls = 8, maxTurns = 20,
  timeoutMs = 12 * 60 * 1000, cli = 'claude', environment = process.env, ...readOptions }) {
  if (!key) throw new Error('No Anthropic API key: nothing was reviewed.');
  const secrets = [key, readOptions.token, ...Object.entries(environment)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && value?.length >= 8)
    .map(([, value]) => value)].filter(Boolean);
  const redact = (text) => [...new Set(secrets)]
    .reduce((value, secret) => value.split(secret).join('<redacted>'), String(text))
    .replace(PRIVATE_KEY_BLOCK, '<redacted>')
    .replace(new RegExp(CREDENTIAL.source, 'g'), '<redacted>');
  const json = (value, space) => JSON.stringify(value,
    (_name, field) => typeof field === 'string' ? redact(field) : field, space);
  if (redact(prompt) !== prompt) throw new Error('Review input contains a credential: no request was sent.');
  const save = (name, value) => {
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, name), json(value, 2) + '\n');
  };
  const home = fs.mkdtempSync(path.join(folder, 'claude-home-'));
  const started = Date.now();
  let used = 0;
  let successful = 0;
  let sourceReads = 0;
  for (const name of ['answer.json', 'adapter-error.json', 'cli-stderr.txt', 'provider.json']) {
    if (out) fs.rmSync(path.join(out, name), { force: true });
  }
  const session = [];
  const tools = readTools(readOptions.shell);
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(405).end(); return; }
    let raw = '';
    for await (const part of request) {
      raw += part;
      if (raw.length > 100_000) { response.writeHead(413).end(); return; }
    }
    try {
      const { id, method, params = {} } = JSON.parse(raw);
      if (id === undefined) { response.writeHead(202).end(); return; }
      let methodResponse;
      if (method === 'initialize') methodResponse = {
        protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'review', version: '1' },
      };
      else if (method === 'ping') methodResponse = {};
      else if (method === 'tools/list') methodResponse = {
        tools: tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })),
      };
      else if (method === 'tools/call') {
        const allowed = tools.some((tool) => tool.name === params.name);
        const output = used++ >= calls ? 'Tool budget reached: report what remains not checked.'
          : !allowed ? 'Tool denied: unknown or write-capable tool.'
            : await readTool({ ...readOptions, folder, name: params.name, args: params.arguments });
        const failed = /^(Read denied|Read failed|Tool denied|Tool budget)/.test(output);
        if (!failed) successful++;
        if (!failed && output.replace(/^\d+: /gm, '').trim() && params.name === 'read_file'
          && path.posix.normalize(String(params.arguments?.path ?? '')).startsWith('pr/')) sourceReads++;
        methodResponse = { content: [{ type: 'text', text: redact(output) }], isError: failed };
        session.push({ name: params.name, arguments: params.arguments, result: methodResponse });
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id, error: { code: -32601, message: 'Method denied' },
        }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, result: methodResponse }));
    } catch { response.writeHead(400).end(); }
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = childEnvironment(environment, key, home);
    const options = { cwd: folder, env };
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
    const version = await runCli(cli, ['--version'], options, '', remaining());
    const match = version.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (version.code !== 0 || !match || Number(match[1]) < 2 ||
      (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 293)))) {
      throw new Error(`Claude Code ${CLAUDE_VERSION} or later is required for Haiku 5.5.`);
    }
    const authRun = await runCli(cli, ['auth', 'status'], options, '', remaining());
    let auth;
    try { auth = JSON.parse(authRun.stdout); } catch { throw new Error('Claude Code auth status was unreadable.'); }
    if (authRun.code !== 0 || !auth.loggedIn || auth.authMethod !== 'api_key' || auth.apiProvider !== 'firstParty')
      throw new Error('Claude Code must authenticate with the supplied company API key.');
    save('provider.json', { provider: 'claude-code', version: match[0], authMethod: auth.authMethod,
      apiProvider: auth.apiProvider, model: CLAUDE_MODEL, effort: 'medium' });
    const config = { mcpServers: { review: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` } } };
    // Bare mode excludes subscription credentials and project customizations; only the explicit read broker is loaded.
    const args = ['--bare', '--print', '--model', CLAUDE_MODEL, '--effort', 'medium', '--output-format', 'json',
      '--tools', '', '--allowedTools', 'mcp__review__*', '--permission-mode', 'dontAsk',
      '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--setting-sources', '',
      '--settings', JSON.stringify({ availableModels: [CLAUDE_MODEL], fallbackModel: [] }),
      '--no-session-persistence', '--no-chrome', '--disable-slash-commands', '--max-turns', String(maxTurns)];
    const done = await runCli(cli, args, options, prompt, remaining());
    if (out && done.stderr) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'cli-stderr.txt'), redact(done.stderr));
    }
    let answer;
    try { answer = JSON.parse(done.stdout); } catch {
      throw new Error('Claude Code returned no valid result: review not done.');
    }
    save('answer.json', answer);
    if (done.code !== 0 || answer.is_error || answer.subtype !== 'success' || !answer.result?.trim())
      throw new Error('Claude Code did not complete the review; inspect the redacted answer artifact.');
    if (redact(answer.result) !== answer.result)
      throw new Error('Claude Code answer contained a credential: review not done.');
    if (sourceReads === 0) throw new Error('Claude Code read no source: review not done.');
    const models = Object.entries(answer.modelUsage ?? {});
    if (models.length !== 1 || models[0][0] !== CLAUDE_MODEL)
      throw new Error('Claude Code effective model did not match the pinned Haiku model.');
    const usage = models[0][1];
    const input = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
      + (usage.cacheCreationInputTokens ?? 0);
    const output = usage.outputTokens ?? 0;
    return { response: answer.result, stats: {
      provider: "claude-code", turns: answer.num_turns, effort: "medium", auth: "api_key", models: { [CLAUDE_MODEL]: {
      api: { totalLatencyMs: Date.now() - started },
      tokens: { prompt: input, candidates: output, thoughts: 0, total: input + output },
    } }, tools: { totalCalls: used, totalSuccess: successful } } };
  } catch (error) {
    save('adapter-error.json', { error: redact(error.message), provider: 'claude-code', model: CLAUDE_MODEL });
    throw new Error(redact(error.message));
  } finally {
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'session.jsonl'),
        session.map((entry) => json(entry)).join('\n') + '\n');
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}
