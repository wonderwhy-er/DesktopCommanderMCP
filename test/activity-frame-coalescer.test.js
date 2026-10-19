import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCoalescer } from '../dist/activity/frame-coalescer.js';

test('a burst of full-screen updates writes only the newest frame', async () => {
    const output = [];
    const frames = new FrameCoalescer({ write: value => output.push(value) }, 15);
    try {
        for (let i = 0; i < 200; i++) frames.write('frame-' + i);
        assert.deepEqual(output, []);
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.deepEqual(output, ['frame-199']);
    } finally {
        frames.close();
    }
});

test('flush emits the latest frame once; shutdown discards pending writes', async () => {
    const output = [];
    const frames = new FrameCoalescer({ write: value => output.push(value) }, 20);
    frames.write('old');
    frames.write('new');
    frames.flush();
    assert.deepEqual(output, ['new']);
    frames.write('must-not-be-rendered-after-exit');
    frames.close();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(output, ['new']);
});

test('reject invalid frame intervals', () => {
    assert.throws(() => new FrameCoalescer({ write() {} }, -1), /nonnegative/);
    assert.throws(() => new FrameCoalescer({ write() {} }, Infinity), /nonnegative/);
});
