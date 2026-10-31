import { formatWithOptions } from 'node:util';

/** Prefix human-readable console output only; stdout also carries MCP JSON-RPC. */
export function startTerminalTimestamps(): () => void {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map((method) => [method, console[method]] as const);
    for (const [method, original] of originals) {
        console[method] = (...args: unknown[]) => {
            const time = new Date().toTimeString().slice(0, 8);
            const stream = method === 'warn' || method === 'error' ? process.stderr : process.stdout;
            const message = formatWithOptions({ colors: stream.isTTY === true }, ...args);
            original.call(console, message.split('\n').map((line) => line ? `[${time}] ${line}` : line).join('\n'));
        };
    }
    return () => {
        for (const [method, original] of originals) console[method] = original;
    };
}
