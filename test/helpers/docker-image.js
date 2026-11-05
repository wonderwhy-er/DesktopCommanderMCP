/**
 * Desktop Commander's Docker image for the tests in test/docker/: builds it
 * from this checkout and checks write_pdf in a container of it, started the
 * way the Docker install starts it (`docker run -i --rm`, with Docker's
 * default security and no extra flags).
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callToolOnceLoaded } from './heavy-packages.js';
import { answerText, closeClient } from './mcp-client.js';

const PROJECT_ROOT =path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// An image without a browser for Alpine downloads Chrome during the first write_pdf before it fails
const WRITE_PDF_TIMEOUT_MS = 300_000;
const TARGET = '/tmp/write-pdf-in-image.pdf';
const HEADING = 'Made in the Docker image';

/**
 * Builds the image `tag` from this checkout, with `dockerfile` in place of the
 * checkout's own when given, printing Docker's output. .dockerignore leaves
 * out this machine's node_modules and dist, so the image installs and builds
 * its own.
 */
export function buildImage(tag, dockerfile) {
  console.log(`Building the image ${tag} (the first build takes a few minutes)...`);
  const file = dockerfile ? ['--file', dockerfile] : [];
  execFileSync('docker', ['build', '--tag', tag, ...file, PROJECT_ROOT], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Runs a docker command and returns its output; it throws when the command fails */
export function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Runs a docker command for cleanup; one that fails (e.g. the container is already gone) is only printed */
export function dockerQuietly(args) {
  try {
    execFileSync('docker', args, { stdio: 'pipe' });
  } catch (error) {
    const message = String(error.stderr ?? error.message).trim();
    if (!/No such (container|image|volume)/.test(message)) console.log(`(docker ${args.join(' ')} failed: ${message})`);
  }
}

/**
 * Starts the server in a container of `image`, named `containerName`, with
 * `dockerArgs` added to `docker run`, then checks that write_pdf makes the PDF
 * and that read_file finds its heading. Prints each check; returns true when
 * both pass.
 */
export async function checkWritePdf(image, containerName, dockerArgs = []) {
  let client;
  let serverStderr = '';
  try {
    const transport = new StdioClientTransport({
      command: 'docker',
      // install-docker.sh's arguments without its folders, plus telemetry off and feature flags
      // from a dead local address, as every test's server gets them (test/helpers/test-env.js)
      args: [
        'run', '-i', '--rm', '--name', containerName, ...dockerArgs,
        '--env', 'DESKTOP_COMMANDER_DISABLE_TELEMETRY=1',
        '--env', 'DC_FLAG_URL=http://127.0.0.1:9/',
        image,
      ],
      // The docker command needs this machine's own settings (its context, DOCKER_HOST)
      env: { ...process.env },
      stderr: 'pipe',
    });
    // Read, so a full pipe never stops the server; printed when a check fails
    transport.stderr?.on('data', (chunk) => { serverStderr += chunk; });
    client = new Client({ name: 'write-pdf-in-image-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport, { timeout: 60_000 });

    const written = await callToolOnceLoaded(client, {
      name: 'write_pdf',
      arguments: { path: TARGET, content: `# ${HEADING}\n\nA PDF that write_pdf made in the container.\n` },
    }, { timeoutMs: WRITE_PDF_TIMEOUT_MS, requestOptions: { timeout: WRITE_PDF_TIMEOUT_MS } });
    assert.ok(!written.isError && answerText(written).includes(`Successfully wrote PDF to ${TARGET}`),
      `write_pdf should write the PDF in the image, got: ${answerText(written)}`);
    console.log('✓ write_pdf wrote the PDF in the image');

    const read = await callToolOnceLoaded(client, { name: 'read_file', arguments: { path: TARGET } });
    assert.ok(!read.isError && answerText(read).includes(HEADING),
      `read_file should find "${HEADING}" in the PDF, got: ${answerText(read)}`);
    console.log('✓ read_file reads the heading back from the PDF');
    return true;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    if (serverStderr.trim()) console.error(`The server's stderr (last 3000 characters):\n${serverStderr.slice(-3000)}`);
    return false;
  } finally {
    await closeClient(client);
    dockerQuietly(['rm', '--force', containerName]);
  }
}
