// Repro (v2): interact_with_process re-join()s the WHOLE buffer every 50ms poll
// (getOutputSinceSnapshot -> outputLines.join('\n'), terminal-manager.ts).
// Phase 1: grow the buffer to ~45MB across MANY lines (so join must concat).
// Phase 2: trickle tiny output over ~3s; the poll loop then joins ~45MB ~60x.
// Measure event-loop lag during Phase 2 only.
//
// Run: node test/test-interact-join-stall.js
import { startProcess, interactWithProcess } from '../../dist/tools/improved-process-tools.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);
const pidFrom = (res) => {
  const m = (res?.content?.[0]?.text || '').match(/PID (\d+)/);
  return m ? Number(m[1]) : null;
};

const started = await startProcess({ command: 'python3 -i -q', timeout_ms: 4000 });
const pid = pidFrom(started);
log(`python pid=${pid}`);
await interactWithProcess({ pid, input: 'import time', timeout_ms: 3000 });

// Phase 1: single expression (no block => no '...' continuation). ~45MB / 3000 lines.
log(`phase 1: growing buffer to ~45MB ...`);
await interactWithProcess({ pid, input: "print('\\n'.join('X'*1200 for _ in range(40000)))", timeout_ms: 15000 });
log(`phase 1 done`);

// Event-loop lag monitor (10ms interval; large delta => synchronous block).
let maxLag = 0, sumLag = 0, samples = 0, last = Date.now();
const mon = setInterval(() => {
  const now = Date.now();
  const lag = now - last - 10;
  if (lag > maxLag) maxLag = lag;
  if (lag > 0) { sumLag += lag; samples++; }
  last = now;
}, 10);

// Phase 2: trickle 40 ticks over ~3.2s so ~60 polls each re-join the 45MB buffer.
log(`phase 2: trickling output while polling ...`);
const t = Date.now();
await interactWithProcess({
  pid,
  input: "[ (time.sleep(0.08) or print('tick', i)) for i in range(40) ]",
  timeout_ms: 12000
});
const wall = Date.now() - t;
clearInterval(mon);

log(`phase 2 wall=${wall}ms`);
log(`event-loop lag during phase 2: max=${maxLag}ms, total blocked=${sumLag}ms over ${samples} stalls`);
log(`blocked ${((sumLag / wall) * 100).toFixed(0)}% of phase-2 wall time`);
log(maxLag > 150 || sumLag > wall * 0.3
  ? `STALL REPRODUCED: per-poll whole-buffer join starves the event loop`
  : `no significant stall observed`);
try { await interactWithProcess({ pid, input: 'exit()', timeout_ms: 800, wait_for_prompt: false }); } catch {}
process.exit(0);
