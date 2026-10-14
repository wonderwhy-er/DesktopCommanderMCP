import { redact } from '../remote-device/diagnostics/redact.js';
export type ActivityPhase = 'plan' | 'progress' | 'done' | 'warning' | 'error';
export interface ActivityAnnouncement { phase: ActivityPhase; message: string; }
interface Row { id: string; tool: string; text: string; state: 'running' | 'done' | 'error' | 'note'; at: number; ms?: number; ai: boolean; }

/** Avoid terminal injection, secret display, and multiline JSON flooding. */
export function safeActivityText(value: unknown, max = 160): string {
    if (typeof value !== 'string') return '';
    return redact(value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);
}

const LABELS: Record<string,string> = {
    start_process: 'Terminal komutu çalıştırılıyor', read_process_output: 'Çalışan işlemin çıktısı inceleniyor',
    interact_with_process: 'Terminal işlemine komut gönderiliyor', force_terminate: 'İşlem durduruluyor',
    list_sessions: 'Terminal oturumları kontrol ediliyor', list_processes: 'Süreçler kontrol ediliyor',
    read_file: 'Dosya okunuyor', read_multiple_files: 'Dosyalar inceleniyor',
    write_file: 'Dosya yazılıyor', edit_block: 'Dosya düzenleniyor', create_directory: 'Klasör oluşturuluyor',
    list_directory: 'Klasör listeleniyor', move_file: 'Dosya taşınıyor',
    start_search: 'Arama başlatılıyor', get_more_search_results: 'Arama sonuçları inceleniyor',
    stop_search: 'Arama durduruluyor', get_file_info: 'Dosya bilgileri inceleniyor',
    get_config: 'Bağlantı ayarları inceleniyor', set_config_value: 'Bağlantı ayarları değiştiriliyor',
    get_usage_stats: 'İstatistikler okunuyor', ping: 'Bağlantı kontrol ediliyor',
    write_pdf: 'PDF oluşturuluyor'
};
export function fallbackDescription(tool: string) { return LABELS[tool] ?? 'MCP işlemi yürütülüyor'; }

/** Terminal UI is opt-in for TTY only; non-TTY emits short, safe status lines. */
export class ActivityView {
    private rows: Row[] = [];
    private pending: { text: string; at: number } | null = null;
    private note = 'Bağlantı hazır';
    private tty: boolean;
    constructor(private output: NodeJS.WriteStream = process.stdout) {
        this.tty = !!output.isTTY && process.env.DC_ACTIVITY_UI !== 'off' && !process.env.NO_COLOR;
    }
    announce(value: ActivityAnnouncement) {
        const text = safeActivityText(value.message);
        if (!text) return;
        this.note = text;
        if (value.phase === 'plan') this.pending = { text, at: Date.now() };
        if (['done','warning','error'].includes(value.phase)) {
            this.rows.push({ id: 'note-' + Date.now(), tool: 'AI', text,
                state: value.phase === 'error' ? 'error' : 'note', at: Date.now(), ai: true });
        }
        this.trim(); this.render();
    }
    started(id: string, tool: string) {
        const text = this.pending && Date.now() - this.pending.at < 120000 ? this.pending.text : '';
        this.pending = null;
        this.rows.push({ id, tool, text: text || fallbackDescription(tool),
            state: 'running', at: Date.now(), ai: !!text });
        this.trim(); this.render();
    }
    finished(id: string, failed = false) {
        const row = this.rows.find(x => x.id === id);
        if (!row) return;
        row.state = failed ? 'error' : 'done';
        row.ms = Date.now() - row.at;
        this.render();
    }
    getSnapshot() { return this.rows.map(x => ({...x})); }
    private trim() { if (this.rows.length > 100) this.rows.splice(0, this.rows.length - 100); }
    private render() {
        if (!this.tty) {
            const row = this.rows[this.rows.length - 1];
            this.output.write('\n' + (row ? (row.state === 'error' ? '✗ ' : row.state === 'done' ? '✓ ' : '• ') + row.text + ' [' + row.tool + ']' : '• ' + this.note) + '\n');
            return;
        }
        const width = Math.min(this.output.columns || 80, 110);
        const short = (value: string, len: number) => Array.from(value).slice(0, len).join('');
        const bar = '─'.repeat(Math.max(20, width-2));
        const lines = this.rows.slice(-9).map(row => {
            const icon = row.state === 'done' ? '✓' : row.state === 'error' ? '✗' : row.state === 'running' ? '◌' : '•';
            return '│ ' + icon + ' ' + short(row.text, Math.max(15,width-24)) + ' [' + (row.ai ? 'AI' : 'auto') + ', ' + (row.ms === undefined ? '...' : row.ms+'ms') + ']';
        });
        const running = this.rows.filter(r => r.state === 'running').length;
        const done = this.rows.filter(r => r.state === 'done').length;
        const errors = this.rows.filter(r => r.state === 'error').length;
        const display = [
            '┌'+bar+'┐', '│ Desktop Commander · İşlem görünümü',
            '│ Aktif: '+running+'    Tamamlandı: '+done+'    Hata: '+errors,
            '├'+bar+'┤', ...lines,
            '├'+bar+'┤', '│ Son açıklama: '+short(this.note, Math.max(10,width-19)), '└'+bar+'┘'
        ].join('\n');
        this.output.write('\x1b[?25l\x1b[H\x1b[2J'+display+'\x1b[?25h\n');
    }
}
