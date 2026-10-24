import assert from 'assert';
import { startProcess, interactWithProcess, readProcessOutput, forceTerminate } from '../../dist/tools/improved-process-tools.js';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows-only nested-shell regression');
  process.exit(0);
}

const marker = 'DC443_DIRECT_SHELL_OK';
const started = await startProcess({
  command: 'powershell -NoProfile -NoLogo',
  shell: 'powershell.exe',
  timeout_ms: 1200,
});
const pid = started.structuredContent?.pid;
assert(pid > 0, `PowerShell session should start, got ${pid}`);

try {
  const markerLeft = marker.slice(0, 6);
  const markerRight = marker.slice(6);
  await interactWithProcess({
    pid,
    // Keep the full marker out of the submitted command so a PowerShell input
    // echo alone cannot satisfy the output assertion.
    input: `Write-Output ('${markerLeft}' + '${markerRight}')`,
    wait_for_prompt: false,
    timeout_ms: 5000,
  });
  let text = '';
  for (let attempt = 0; attempt < 5 && !text.includes(marker); attempt += 1) {
    const output = await readProcessOutput({ pid, timeout_ms: 1000 });
    text += `\n${output.content?.[0]?.text ?? ''}`;
  }
  assert(text.includes(marker),
    `interactive command should return through Desktop Commander's pipes, got: ${text}`);
  console.log('PASS: direct PowerShell shell invocation remains interactive over stdio pipes');
} finally {
  await forceTerminate({ pid });
}
