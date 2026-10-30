// Repro (v2): interact_with_process re-join()s the WHOLE buffer every 50ms poll
// (getOutputSinceSnapshot -> outputLines.join('\n'), terminal-manager.ts).
// Baseline: trickle tiny output over ~3s while the buffer is still small.
// Phase 1: grow the buffer to ~45MB across MANY lines (so join must concat).
// Phase 2: the same trickle; the poll loop then joins ~45MB ~60x.
// Compare the CPU time this process spends in Phase 2 with the baseline's.
//
// CPU time comes from process.cpuUsage(). Other load on the machine makes the
// work take longer but barely changes how much CPU it takes, while the event
// loop's busy share (performance.eventLoopUtilization(), time spent running
// code vs. waiting) and timer lateness both grow with it. Those two are still
// logged, as information.
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

// Trickle 40 ticks over ~3.2s so ~60 polls each read the buffer. Returns the
// CPU time this process spent meanwhile, and the busy share and longest block
// (10ms interval; large delta => synchronous block) as information.
// The wait ends at Python's prompt; 30s is room for a loaded machine.
async function trickle() {
  let maxLag = 0, last = Date.now();
  const mon = setInterval(() => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  const eluStart = performance.eventLoopUtilization();
  const cpuStart = process.cpuUsage();
  const t = Date.now();
  await interactWithProcess({
    pid,
    input: "[ (time.sleep(0.08) or print('tick', i)) for i in range(40) ]",
    timeout_ms: 30000
  });
  const cpu = process.cpuUsage(cpuStart);
  const elu = performance.eventLoopUtilization(eluStart);
  clearInterval(mon);
  return { cpuMs: Math.round((cpu.user + cpu.system) / 1000), wall: Date.now() - t, elu, maxLag };
}
const describe = (r) => `wall=${r.wall}ms, CPU ${r.cpuMs}ms, event loop busy ${(r.elu.utilization * 100).toFixed(1)}%, longest block ${r.maxLag}ms`;

log(`baseline: trickling output while polling a small buffer ...`);
const baseline = await trickle();
log(`baseline ${describe(baseline)}`);

// Phase 1: single expression (no block => no '...' continuation). ~45MB / 3000 lines.
// The wait ends at Python's prompt once all of it is read; 45s (under the 50s
// wait ceiling) is room for a loaded machine. Phase 2 must not start while it
// still arrives: reading it would count as Phase 2's work.
log(`phase 1: growing buffer to ~45MB ...`);
const grown = await interactWithProcess({ pid, input: "print('\\n'.join('X'*1200 for _ in range(40000)))", timeout_ms: 45000 });
let failed;
if ((grown.content?.[0]?.text ?? '').includes('timeout reached')) {
  log(`phase 1 did not finish within 45s: cannot measure`);
  failed = true;
} else {
  log(`phase 1 done`);

  log(`phase 2: trickling output while polling ...`);
  const phase2 = await trickle();
  log(`phase 2 ${describe(phase2)}`);

  // Waiting on a trickling process should cost about the same however much it
  // printed before. The whole-buffer join kept the loop ~20% busy here and
  // reading only new output ~2%: roughly 600ms against 60ms of the ~3.2s.
  // Twice the baseline plus 100ms leaves room for noise and still catches it.
  const limitMs = 2 * baseline.cpuMs + 100;
  failed = phase2.cpuMs > limitMs;
  log(failed
    ? `STALL REPRODUCED: per-poll whole-buffer join starves the event loop (CPU ${phase2.cpuMs}ms > ${limitMs}ms)`
    : `no significant stall observed (CPU ${phase2.cpuMs}ms <= ${limitMs}ms)`);
}
try { await interactWithProcess({ pid, input: 'exit()', timeout_ms: 800, wait_for_prompt: false }); } catch {}
// Exit code: 1 while the stall reproduces (or when Phase 1 could not set it up)
exitProcess(failed ? 1 : 0);
