/**
 * Device context (src/device-context): runs the suites in test/device-context/ under the normal runner.
 *
 * - Each device-context*.test.mjs suite must exit 0 (they print "all passed" or "N FAILED").
 * - adversarial.test.mjs probes attacks and edge cases. Gaps that are known and documented in
 *   src/device-context/README.md are reported with skip(), so they show up in the summary instead of
 *   passing silently; any other FAIL line, or a failing control, fails this test.
 * - The eval and VPS scripts in test/device-context/eval, photos/ etc. are dev-only and never run here.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain, skip } from './helpers/run-if-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test', 'device-context');

// Known, documented gaps (README, "Limitations"): skipped with their reason, never silently passed
const KNOWN_GAPS = {
    macos_case_variants_split_one_project: 'case variants of one path on macOS split one project (low)',
    second_concurrent_chat_without_id_gets_no_card: 'two chats at once without a chat id share one note (inherent without a chat id)',
    card_under_2000_chars_for_heavy_user: 'a heavy user\'s card is ~2,400 characters, over the 2,000 target (low)',
    docker_volume_arg_creates_bogus_root: 'a docker -v volume path can create a false project root on Windows (med)',
};

function runSuite(file) {
    const res = spawnSync(process.execPath, [file, './dist'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env } });
    return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, stdout: res.stdout || '' };
}

async function runTests() {
    let ok = true;
    const suites = fs.readdirSync(DIR).filter((f) => /^device-context.*\.test\.mjs$/.test(f)).sort();
    for (const f of suites) {
        const { code, out, stdout } = runSuite(path.join(DIR, f));
        const last = stdout.trim().split('\n').at(-1) ?? '';   // stdout only: a deprecation warning on stderr may come last
        if (code === 0 && /all passed/.test(last)) console.log(`✅ ${f}`);
        else { ok = false; console.error(`❌ ${f} (exit ${code})\n${out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 10).join('\n')}`); }
    }

    const adv = runSuite(path.join(DIR, 'adversarial.test.mjs'));
    const fails = [...adv.out.matchAll(/FAIL \[[^\]]+\] (\S+)/g)].map((m) => m[1]);
    for (const name of fails) {
        if (KNOWN_GAPS[name]) skip(`device context, known gap: ${KNOWN_GAPS[name]}`);
        else { ok = false; console.error(`❌ adversarial: unexpected FAIL ${name}`); }
    }
    const controls = adv.out.match(/controls: (\d+)\/(\d+) pass/);
    if (adv.code !== 0 || !controls || controls[1] !== controls[2]) { ok = false; console.error(`❌ adversarial: exit ${adv.code}, controls ${controls?.[0] ?? 'missing'}`); }
    else console.log(`✅ adversarial.test.mjs (${fails.length} known gap(s) skipped, ${controls[0]})`);

    return ok;
}

runIfMain(import.meta.url, runTests);
