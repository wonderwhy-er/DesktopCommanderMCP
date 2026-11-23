/** Force the real index entry through a bootstrap copy, including on hosts that do not need one. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestEnv } from './helpers/test-env.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { runNode } from './helpers/run-node.js';

test('a forced bootstrap copy preserves remote report dispatch and no-upload', async () => {
    const sandbox = createTestEnv();
    const standIn = await startRemoteStandIn({ diagnostics: true, realtime: true });
    try {
        const preload = path.join(sandbox.home, 'force-copy.mjs');
        const threadpoolModule = new URL('../dist/utils/threadpool-size.js', import.meta.url).href;
        fs.writeFileSync(preload, `import {setThreadpoolSize} from ${JSON.stringify(threadpoolModule)};
setThreadpoolSize('16', false);
`);
        const { UV_THREADPOOL_SIZE, ...inherited } = sandbox.env;
        const env = { ...inherited, MCP_SERVER_URL: standIn.url,
            HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '' };
        const index = new URL('../dist/index.js', import.meta.url);
        const child = await runNode(['--import', pathToFileURL(preload).href, fileURLToPath(index),
            'remote', '--report', '--no-upload'], { env });
        assert.equal(child.status, 0, child.stdout + child.stderr);
        assert.match(child.stdout, /Saved: .+\.zip/);
        assert.match(child.stdout, /Reply to your support conversation with this file attached/);
        assert.equal(standIn.uploads.length, 0, '--no-upload reaches remote dispatch unchanged');
        assert.equal(standIn.requests.filter((request) => request.url.startsWith('/auth/')).length, 0);
    } finally {
        await standIn.close();
        sandbox.cleanup();
    }
});
