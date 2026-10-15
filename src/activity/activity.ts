import { redact } from '../remote-device/diagnostics/redact.js';

export type ActivityPhase = 'plan' | 'progress' | 'done' | 'warning' | 'error';
export interface ActivityAnnouncement { phase: ActivityPhase; message: string; }
type RowState = 'running' | 'done' | 'error' | 'note';
interface ActivityRow {
    id: string; tool: string; text: string; state: RowState;
    at: number; ms?: number; ai: boolean;
}

/** Treat model-authored text as untrusted terminal output, not as a command. */
export function safeActivityText(value: unknown, max = 160): string {
    if (typeof value !== 'string') return '';
    const clean = value
        .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return redact(clean).slice(0, max);
}

const LABELS: Record<string, string> = {
    start_process: 'Terminal komutu çalıştırılıyor', read_process_output: 'Çalışan işlemin çıktısı inceleniyor',
    interact_with_process: 'Terminal işlemine komut gönderiliyor', force_terminate: 'İşlem durduruluyor',
    list_sessions: 'Terminal oturumları kontrol ediliyor', list_processes: 'Süreçler kontrol ediliyor',
    read_file: 'Dosya okunuyor', read_multiple_files: 'Dosyalar inceleniyor',
    write_file: 'Dosya yazılıyor', edit_block: 'Dosya düzenleniyor', create_directory: 'Klasör oluşturuluyor',
    list_directory: 'Klasör listeleniyor', move_file: 'Dosya taşınıyor',
    start_search: 'Arama başlatılıyor', get_more_search_results: 'Arama sonuçları inceleniyor',
    stop_search: 'Arama durduruluyor', get_file_info: 'Dosya bilgileri inceleniyor',
    get_config: 'Bağlantı ayarları inceleniyor', set_config_value: 'Bağlantı ayarları değiştiriliyor',
    get_usage_stats: 'İstatistikler okunuyor', ping: 'Bağlantı kontrol ediliyor', write_pdf: 'PDF oluşturuluyor',
};
export function fallbackDescription(tool: string): string { return LABELS[tool] ?? 'MCP işlemi yürütülüyor'; }

/** Presentation-only state; events are never allowed to change device actions. */
export class ActivityView {
    private rows: ActivityRow[] = [];
    private pending: { text: string; at: number } | null = null;
    private note = 'Bağlantı hazır';
    private readonly tty: boolean;
    private readonly maxRows = 100;
    private readonly maxTrackedCalls = 4096;
    private readonly activeCalls = new Map<string, number>();
    private droppedTracking = 0;
    private sequence = 0;
    private completed = 0;
    private failed = 0;

    constructor(private readonly output: NodeJS.WriteStream = process.stdout) {
        this.tty = !!output.isTTY && process.env.DC_ACTIVITY_UI !== 'off' && !process.env.NO_COLOR;
    }

    announce(value: ActivityAnnouncement): void {
        const text = safeActivityText(value.message);
        if (!text) return;
        this.note = text;
        if (value.phase === 'plan') this.pending = { text, at: Date.now() };
        if (['done', 'warning', 'error'].includes(value.phase)) {
            this.rows.push({
                id: `note-${++this.sequence}`, tool: 'AI', text,
                state: value.phase === 'error' ? 'error' : 'note',
                at: Date.now(), ai: true,
            });
            this.trim();
        }
        this.render();
    }

    started(id: string, tool: string, authoredText?: string): void {
        if (this.activeCalls.has(id) || this.rows.some(row => row.id === id)) return;
        const at = Date.now();
        this.activeCalls.set(id, at);
        if (this.activeCalls.size > this.maxTrackedCalls) {
            const oldest = this.activeCalls.keys().next().value;
            if (oldest !== undefined) this.activeCalls.delete(oldest);
            this.droppedTracking++;
        }
        const explicit = safeActivityText(authoredText);
        const text = explicit || (this.pending && Date.now() - this.pending.at < 120000 ? this.pending.text : '');
        this.pending = null;
        this.note = text || fallbackDescription(tool);
        this.rows.push({
            id, tool, text: this.note, state: 'running', at, ai: !!text,
        });
        this.trim();
        this.render();
    }

    finished(id: string, failed = false): void {
        const startedAt = this.activeCalls.get(id);
        if (startedAt === undefined) return; // Duplicate or unexpected completion.
        this.activeCalls.delete(id);
        const row = this.rows.find(item => item.id === id);
        if (row) {
            row.state = failed ? 'error' : 'done';
            row.ms = Math.max(0, Date.now() - startedAt);
        }
        if (failed) this.failed++;
        else this.completed++;
        this.render();
    }

    refresh(): void { this.render(); }

    getSnapshot(): ReadonlyArray<Readonly<ActivityRow>> {
        return this.rows.map(row => ({ ...row }));
    }

    getTotals(): Readonly<{ active: number; completed: number; failed: number }> {
        return Object.freeze({
            active: this.activeCalls.size,
            completed: this.completed, failed: this.failed,
        });
    }

    private trim(): void {
        // Screen history stays bounded even when the provider never sends an end
        // event. The separately bounded activeCalls map keeps completion counts
        // correct for active operations that scrolled out of the visible history.
        while (this.rows.length > this.maxRows) {
            const index = this.rows.findIndex(row => row.state !== 'running');
            this.rows.splice(index < 0 ? 0 : index, 1);
        }
    }

    private render(): void {
        if (!this.tty) {
            const row = this.rows[this.rows.length - 1];
            const icon = !row ? '•' : row.state === 'error' ? '✗' : row.state === 'done' ? '✓' : '•';
            this.output.write(`\n${icon} ${row ? row.text + ' [' + row.tool + ']' : this.note}\n`);
            return;
        }

        const width = Math.max(36, Math.min(this.output.columns || 80, 110));
        const inner = width - 2;
        const limit = (s: string, max: number): string => {
            const chars = Array.from(s);
            return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
        };
        const line = (s: string): string => '│' + limit(' ' + s, inner).padEnd(inner, ' ') + '│';
        const border = (left: string, right: string): string => left + '─'.repeat(inner) + right;
        const count = this.getTotals();
        const height = Math.max(4, (this.output.rows || 24) - 9);
        const entries = this.rows.slice(-Math.min(9, height)).map(row => {
            const symbol = row.state === 'done' ? '✓' : row.state === 'error' ? '✗'
                : row.state === 'running' ? '◌' : '•';
            const meta = row.state === 'note' ? '[AI]' : `[${row.ai ? 'AI' : 'auto'}, ${row.ms === undefined ? '...' : row.ms + 'ms'}]`;
            const available = inner - Array.from(meta).length - 5;
            return line(`${symbol} ${limit(row.text, Math.max(5, available))} ${meta}`);
        });

        const display = [
            border('┌', '┐'),
            line('Desktop Commander · İşlem görünümü'),
            line(`Aktif: ${count.active}    Tamamlandı: ${count.completed}    Hata: ${count.failed}`),
            border('├', '┤'),
            ...entries,
            border('├', '┤'),
            line('Son açıklama: ' + this.note),
            border('└', '┘'),
        ].join('\n');
        this.output.write('\x1b[H\x1b[2J' + display + '\n');
    }
}
