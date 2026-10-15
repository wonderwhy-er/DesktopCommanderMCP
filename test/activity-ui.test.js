import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityView, fallbackDescription, safeActivityText } from '../dist/activity/activity.js';

const terminal = (columns = 92, rows = 24) => {
    const chunks = [];
    const output = { isTTY: true, columns, rows, write(data) { chunks.push(data); } };
    const view = new ActivityView(output);
    return { view, output, chunks, latest: () => chunks.at(-1) };
};

test('text sanitization strips ANSI/control sequences and redacts secrets', () => {
    assert.equal(safeActivityText('\x1b[2Jalpha\n beta'), 'alpha beta');
    assert.ok(!safeActivityText('access_token=SUPER_SECRET_VALUE').includes('SUPER_SECRET_VALUE'));
});

test('native dashboard uses real operations, no generated labels or narrative content', () => {
    const { view, latest } = terminal();
    view.announce({ phase: 'plan', message: 'YAPAY ZEKA GIZLI METNI' });
    view.started('a', 'start_process', 'ALSO SHOULD NOT DISPLAY');
    view.finished('a');
    const screen = latest();
    assert.match(screen, /DESKTOP COMMANDER/);
    assert.match(screen, /SUCCESS:\s*1/);
    assert.match(screen, /Execute command/);
    assert.match(screen, /OK/);
    assert.doesNotMatch(screen, /YAPAY ZEKA|ALSO SHOULD|AI,|İşlem görünümü/);
    assert.equal(view.getSnapshot()[0].text, 'Execute command');
    assert.equal(view.getSnapshot()[0].ai, false);
});

test('arrows, PageUp, Home and mouse wheel control scrollback', () => {
    const { view, latest } = terminal(92, 15);
    for (let i = 0; i < 30; i++) {
        view.started('c-' + i, 'task_' + i);
        view.finished('c-' + i);
    }
    view.handleInput('\x1b[A');
    assert.equal(view.getScroll(), 1);
    view.handleInput('\x1b[5~');
    assert.ok(view.getScroll() > 1);
    view.handleInput('\x1b[<64;22;12M'); // wheel up
    const afterUp = view.getScroll();
    view.handleInput('\x1b[<65;22;12M'); // wheel down
    assert.ok(view.getScroll() < afterUp);
    view.handleInput('\x1b[H');
    assert.ok(view.getScroll() > 0);
    view.handleInput('\x1b[F');
    assert.equal(view.getScroll(), 0);
    view.handleInput('\x1b[B');
    assert.equal(view.getScroll(), 0);
    assert.doesNotMatch(latest(), /\^\[\[A|\^\[\[B/);
    assert.equal(view.handleInput('q'), true);
    assert.equal(view.handleInput('\x03'), true);
});

test('split escape sequences and burst arrow events never enter the display', () => {
    const { view, latest } = terminal();
    for (let i = 0; i < 24; i++) { view.started('id-' + i, 'get_config'); view.finished('id-' + i); }
    view.handleInput('\x1b[');
    view.handleInput('A');
    assert.equal(view.getScroll(), 1);
    view.handleInput('\x1b[<64;20;');
    view.handleInput('8M');
    assert.equal(view.getScroll(), 4);
    const before = latest();
    const chunksBefore = view.getScroll();
    view.handleInput(('\x1b[A\x1b[B').repeat(500));
    assert.equal(view.getScroll(), chunksBefore);
    assert.doesNotMatch(latest(), /\^\[|YAPAY ZEKA/);
});

test('view always respects physical terminal columns and rows', () => {
    for (const [columns, rows] of [[35,12],[50,9],[80,24],[120,12],[150,40]]) {
        const { view, output, latest } = terminal(columns, rows);
        for (let i = 0; i < 30; i++) {
            view.started('id-' + i, 'very_long_task_name_with_argument_' + i);
            view.finished('id-' + i, i % 5 === 0);
        }
        output.columns = Math.max(1, columns - 7);
        output.rows = Math.max(1, rows - 3);
        view.refresh();
        const visible = latest().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        const lines = visible.split('\r\n');
        assert.ok(lines.length <= output.rows, 'must fit rows');
        for (const line of lines) assert.ok([...line].length <= output.columns, 'must fit width');
    }
});

test('duplicate events, concurrency and bounded history preserve totals', () => {
    const { view } = terminal();
    for (let i = 0; i < 1400; i++) {
        view.started('event-' + i, 'list_directory');
        if (i !== 9) view.finished('event-' + i, i % 25 === 0);
    }
    assert.equal(view.getSnapshot().length, 1000);
    assert.equal(view.getTotals().active, 1);
    view.finished('event-9');
    view.finished('event-9');
    assert.equal(view.getTotals().active, 0);
    assert.equal(view.getTotals().failed, 56);
    assert.equal(view.getTotals().completed, 1344);
});

test('tiny terminals show compact status without writing past the viewport', () => {
    for (const [width, height] of [[1,1],[2,2],[10,4],[30,8],[37,9],[80,8]]) {
        const { view, latest } = terminal(width, height);
        view.started('small-' + width, 'get_config');
        view.finished('small-' + width);
        const clear = latest().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        const lines = clear.split('\r\n');
        assert.ok(lines.length <= height, 'height ' + height);
        assert.ok(lines.every(x => [...x].length <= width), 'width ' + width);
        if (width >= 15) assert.match(clear, /ACTIVITY/);
    }
});

test('hostile MCP tool names cannot inject escapes into non-tty logs', () => {
    const chunks = [];
    const view = new ActivityView({ isTTY: false, write: data => chunks.push(data) });
    view.started('malicious', 'get_config\x1b[2J\nTOKEN=SECRET');
    view.finished('malicious');
    assert.ok(chunks.every(x => !x.includes('\x1b') && !x.includes('TOKEN=SECRET')));
    assert.equal(view.getSnapshot()[0].tool, 'unknown_operation');
});
