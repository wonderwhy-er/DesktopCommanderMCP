import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ActivityView } from '../dist/activity/activity.js';
import { createActivityMonitor, parseActivityEvent, publishActivityEvent } from '../dist/activity/channel.js';

const sink = () => new ActivityView({ isTTY: false, write() {} });

test('duplicate and old activity entries never inflate successful call totals', () => {
    const view = sink();
    view.started('one', 'read_file', 'Kaynak dosyası inceleniyor');
    view.started('one', 'read_file', 'Tekrarlandı');
    view.finished('one', false);
    view.finished('one', false);
    assert.deepEqual(view.getTotals(), { active: 0, completed: 1, failed: 0 });
    for (let i = 0; i < 160; i++) {
        view.started('other-' + i, 'get_config');
        view.finished('other-' + i);
    }
    assert.equal(view.getSnapshot().length, 161);
    assert.equal(view.getTotals().completed, 161);
});

test('protocol rejects invalid events and trims model-authored descriptions', () => {
    assert.equal(parseActivityEvent({ kind: 'started', id: 'a', tool: 'a b' }), null);
    assert.equal(parseActivityEvent({ kind: 'finished', id: 42, failed: 'true' }), null);
    const event = parseActivityEvent({ kind: 'started', id: '1', tool: 'read_file',
        text: '\x1b[2JStatus: read_file' });
    assert.equal(event.text, 'Status: read_file');
});

test('activity monitor fails safely when a second instance attempts the same socket', { skip: process.platform === 'win32' }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dcmcp-live-socket-'));
    const socket = path.join(home, 'private', 'monitor.sock');
    const first = await createActivityMonitor(sink(), socket);
    try {
        await assert.rejects(createActivityMonitor(sink(), socket), /already running/);
        assert.equal((await stat(socket)).isSocket(), true);
    } finally {
        await first.close();
        await rm(home, { recursive: true, force: true });
    }
});

test('a regular file at the activity socket path is never deleted', { skip: process.platform === 'win32' }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dcmcp-foreign-socket-'));
    const directory = path.join(home, 'private');
    await mkdir(directory, { mode: 0o700 });
    const socket = path.join(directory, 'monitor.sock');
    await writeFile(socket, 'not a socket');
    try {
        await assert.rejects(createActivityMonitor(sink(), socket), /Refusing to replace/);
        assert.equal((await stat(socket)).isFile(), true);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('monitor recovers a stale owner-owned Unix socket left by an interrupted process', { skip: process.platform === 'win32' }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dcmcp-stale-socket-'));
    const directory = path.join(home, 'private');
    await mkdir(directory, { mode: 0o700 });
    const socket = path.join(directory, 'monitor.sock');
    const created = spawnSync('python3', ['-c',
        'import socket,os,sys; s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);os._exit(0)', socket]);
    assert.equal(created.status, 0);
    const view = sink();
    const monitor = await createActivityMonitor(view, socket);
    try {
        assert.equal((await stat(socket)).isSocket(), true);
        const previous = process.env.DC_ACTIVITY_SOCKET;
        process.env.DC_ACTIVITY_SOCKET = socket;
        try {
            await publishActivityEvent({ kind: 'started', id: 'after-restart', tool: 'ping',
                text: 'Yeniden bağlantı testi' });
            for (let i = 0; i < 50 && view.getSnapshot().length === 0; i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(view.getSnapshot()[0].text, 'Check connection');
        } finally {
            if (previous === undefined) delete process.env.DC_ACTIVITY_SOCKET;
            else process.env.DC_ACTIVITY_SOCKET = previous;
        }
    } finally {
        await monitor.close();
        await rm(home, { recursive: true, force: true });
    }
});

test('unfinished event storms do not grow UI history and completing hidden calls still counts', () => {
    const view = sink();
    for (let index = 0; index < 250; index++) {
        view.started('storm-' + index, 'start_process');
    }
    assert.equal(view.getSnapshot().length, 250);
    assert.equal(view.getTotals().active, 250);
    for (let index = 0; index < 250; index++) {
        view.finished('storm-' + index, index % 50 === 0);
    }
    assert.equal(view.getTotals().active, 0);
    assert.equal(view.getTotals().completed, 245);
    assert.equal(view.getTotals().failed, 5);
});
