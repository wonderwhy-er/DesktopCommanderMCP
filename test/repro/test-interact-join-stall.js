// Repro (v2): interact_with_process re-join()s the WHOLE buffer every 50ms poll
// (getOutputSinceSnapshot -> outputLines.join('\n'), terminal-manager.ts).
// Phase 1: grow the buffer to ~45MB across MANY lines (so join must concat).
// Phase 2: trickle tiny output over ~3s; the poll loop then joins ~45MB ~60x.
// Measure how busy the event loop is during Phase 2 only.
//
// Busy time comes from performance.eventLoopUtilization() (time the loop spends
// running code vs. waiting). Timer lateness is not used for the average: timers
// tick every ~15.6ms on Windows, so an idle 10ms interval already reads as ~36%
// "lag" there. The 10ms monitor still catches a single long block (max lag).
//
// Run: node test/repro/run-repro.js test-interact-join-stall.js
import { performance } from 'perf_hooks';
import { startProcess, interactWithProcess } from '../../dist/tools/improved-process-tools.js';
import { getSystemInfo } from '../../dist/utils/system-info.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);

const started = await startProcess({ command: `${getSystemInfo().pythonInfo.command} -i -q`, timeout_ms: 4000 });
const pid = started.structuredContent?.pid;
log(`python pid=${pid}`);
await interactWithProcess({ pid, input: 'import time', timeout_ms: 3000 });

// Phase 1: single expression (no block => no '...' continuation). ~45MB / 3000 lines.
log(`phase 1: growing buffer to ~45MB ...`);
await interactWithProcess({ pid, input: "print('\\n'.join('X'*1200 for _ in range(40000)))", timeout_ms: 15000 });
log(`phase 1 done`);

// Longest single block (10ms interval; large delta => synchronous block).
let maxLag = 0, last = Date.now();
const mon = setInterval(() => {
  const now = Date.now();
  maxLag = Math.max(maxLag, now - last - 10);
  last = now;
}, 10);
const eluStart = performance.eventLoopUtilization();

// Phase 2: trickle 40 ticks over ~3.2s so ~60 polls each re-join the 45MB buffer.
log(`phase 2: trickling output while polling ...`);
const t = Date.now();
await interactWithProcess({
  pid,
  input: "[ (time.sleep(0.08) or print('tick', i)) for i in range(40) ]",
  timeout_ms: 12000
});
const wall = Date.now() - t;
const elu = performance.eventLoopUtilization(eluStart);
clearInterval(mon);

// Waiting on a trickling process should leave the loop almost idle. The
// whole-buffer join kept it ~20% busy here; reading only new output, ~2%.
const MAX_BUSY = 0.10;
log(`phase 2 wall=${wall}ms`);
log(`event loop busy ${(elu.utilization * 100).toFixed(1)}% (${elu.active.toFixed(0)}ms active), longest block ${maxLag}ms`);
const stalled = maxLag > 150 || elu.utilization > MAX_BUSY;
log(stalled
  ? `STALL REPRODUCED: per-poll whole-buffer join starves the event loop`
  : `no significant stall observed`);
try { await interactWithProcess({ pid, input: 'exit()', timeout_ms: 800, wait_for_prompt: false }); } catch {}
// Exit code: 1 while the stall reproduces
exitProcess(stalled ? 1 : 0);
