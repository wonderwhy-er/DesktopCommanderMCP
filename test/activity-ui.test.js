import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityView, fallbackDescription, safeActivityText } from '../dist/activity/activity.js';

test('does not allow escape sequences or multiline command dumps', () => {
    const value = safeActivityText('\u001b[2JWHOIS\n sorgusu\tbaşlatıldı');
    assert.equal(value, 'WHOIS sorgusu başlatıldı');
    assert.ok(safeActivityText('a'.repeat(200)).length <= 160);
});
test('masks sensitive values in model-authored text', () => {
    const value = safeActivityText('access_token=SUPER_SECRET_VALUE');
    assert.ok(!value.includes('SUPER_SECRET_VALUE'));
});
test('AI-provided explanation is attached to the following real tool call', () => {
    const chunks = [];
    const view = new ActivityView({ isTTY: false, write: value => chunks.push(value) });
    view.announce({ phase: 'plan', message: 'Hedef klasörün dosyaları inceleniyor' });
    view.started('id-1', 'list_directory');
    assert.equal(view.getSnapshot()[0].text, 'Hedef klasörün dosyaları inceleniyor');
    assert.equal(view.getSnapshot()[0].ai, true);
    view.finished('id-1');
    assert.equal(view.getSnapshot()[0].state, 'done');
    view.started('id-2', 'read_file');
    assert.equal(view.getSnapshot()[1].ai, false);
    assert.equal(view.getSnapshot()[1].text, fallbackDescription('read_file'));
    view.finished('id-2', true);
    assert.equal(view.getSnapshot()[1].state, 'error');
    assert.ok(chunks.every(value => !value.includes('SUPER_SECRET_VALUE')));
});
test('does not guess a model explanation when absent', () => {
    const view = new ActivityView({ isTTY: false, write: () => {} });
    view.started('id-1','start_process');
    assert.equal(view.getSnapshot()[0].ai, false);
    assert.equal(view.getSnapshot()[0].text, 'Terminal komutu çalıştırılıyor');
});

test('TTY dashboard displays bounded activity rather than raw tool JSON', () => {
    const chunks = [];
    const view = new ActivityView({ isTTY: true, columns: 80, write: value => chunks.push(value) });
    view.announce({ phase: 'plan', message: 'Ağ adresinin sahibi sorgulanıyor' });
    view.started('call-1', 'start_process');
    view.finished('call-1');
    const screen = chunks.at(-1);
    assert.match(screen, /İşlem görünümü/);
    assert.match(screen, /Ağ adresinin sahibi sorgulanıyor/);
    assert.ok(!screen.includes('tool_args'));
    assert.ok(!screen.includes('JSON.stringify'));
});

test('parallel call descriptions remain attached to their own call IDs', () => {
    const view = new ActivityView({ isTTY: false, write: () => {} });
    view.started('a', 'read_file', 'İlk kaynak dosyası okunuyor');
    view.started('b', 'start_process', 'İkinci işlem başlatılıyor');
    view.finished('b');
    view.finished('a');
    const snapshot = view.getSnapshot();
    assert.equal(snapshot[0].text, 'İlk kaynak dosyası okunuyor');
    assert.equal(snapshot[1].text, 'İkinci işlem başlatılıyor');
    assert.equal(snapshot[0].ai, true);
    assert.equal(snapshot[1].ai, true);
    assert.equal(snapshot[0].state, 'done');
    assert.equal(snapshot[1].state, 'done');
});

test('last explanation follows real tool calls', () => {
    const output = [];
    const view = new ActivityView({ isTTY: true, columns: 100, write: text => output.push(text) });
    view.started('new-call', 'list_directory', 'Proje dizini denetleniyor');
    view.finished('new-call');
    assert.match(output.at(-1), /Son açıklama: Proje dizini denetleniyor/);
});
