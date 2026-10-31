/**
 * salvageSettings() and buildRecoveredConfig() (src/config-recovery.ts), called
 * directly: what replaces a damaged config.json. salvageSettings() keeps the
 * longest beginning of the text that is a JSON object once closed, so every
 * complete top-level setting before the damage, whatever its key, and {} when
 * nothing is readable. buildRecoveredConfig() puts it over the defaults (and,
 * while running, over the settings last read), and keeps the welcome page off.
 *
 * test-config-damaged-reset.js checks the same through the config manager, in
 * a temporary home; these are the plain functions, in-process.
 */
import assert from 'assert';
import { salvageSettings, buildRecoveredConfig } from '../dist/config-recovery.js';
import { runIfMain } from './helpers/run-if-main.js';

const DEFAULTS = {
  allowedDirectories: [],
  blockedCommands: ['mkfs', 'sudo'],
  telemetryEnabled: true,
  fileReadLineLimit: 1000,
  welcomeOnboardingEligible: true,
};

/** The defaults, a copy each time, so a function changing them shows */
const defaults = () => structuredClone(DEFAULTS);

async function run() {
  const failures = [];
  let total = 0;
  const check = async (name, test) => {
    total++;
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`✗ ${name}\n  ${error.message}`);
    }
  };

  // 1. Cut short (a write cut off): every complete setting before the cut
  await check('cut short: every complete setting before the cut, the cut one gets its default', () => {
    const text = '{\n  "allowedDirectories": ["/work", "/data"],\n  "telemetryEnabled": false,\n  "blockedCommands": ["mkfs", "su';
    assert.deepStrictEqual(salvageSettings(text), { allowedDirectories: ['/work', '/data'], telemetryEnabled: false });
    assert.deepStrictEqual(salvageSettings('{"note": "a, b", "telemetryEnabled": fal'), { note: 'a, b' },
      'a comma inside a string is not a place to cut');
    const config = buildRecoveredConfig(defaults(), null, text);
    assert.deepStrictEqual(config, {
      ...DEFAULTS, allowedDirectories: ['/work', '/data'], telemetryEnabled: false,
      welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false,
    });
  });

  // 2. A typo in the middle: what comes before it, defaults for it and everything after
  await check('typo in the middle: the settings before it, the defaults for the rest', () => {
    const text = '{"allowedDirectories": ["/work"], "fileReadLineLimit": 50O, "telemetryEnabled": false}';
    assert.deepStrictEqual(salvageSettings(text), { allowedDirectories: ['/work'] });
    const config = buildRecoveredConfig(defaults(), null, text);
    assert.deepStrictEqual([config.allowedDirectories, config.fileReadLineLimit, config.telemetryEnabled], [['/work'], 1000, true]);
    assert.deepStrictEqual(salvageSettings('{"someFutureSetting": {"on": true}, "x": }'), { someFutureSetting: { on: true } },
      'any key is kept, not only known settings');
  });

  // 3. Nothing readable: empty, zero-filled, not an object
  await check('empty, NUL bytes or not an object: nothing readable, the defaults', () => {
    for (const text of ['', '\0\0\0\0\0\0\0\0', '   ', '[1, 2]', '"text"', 'null']) {
      assert.deepStrictEqual(salvageSettings(text), {}, `${JSON.stringify(text)} has no readable settings`);
      assert.deepStrictEqual(buildRecoveredConfig(defaults(), null, text),
        { ...DEFAULTS, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }, `${JSON.stringify(text)}: the defaults`);
    }
  });

  // 4. Saved as "UTF-8 with BOM"
  await check('a BOM before the object is skipped', () => {
    assert.deepStrictEqual(salvageSettings('\uFEFF{"allowedDirectories": ["/work"], "telemetryEnabled": tr'), { allowedDirectories: ['/work'] });
    assert.deepStrictEqual(salvageSettings('\uFEFF{"allowedDirectories": ["/work"]}garbage'), { allowedDirectories: ['/work'] });
  });

  // 5. Nested values: a setting is kept whole or not at all
  await check('nested object: commas inside it are not cuts; one cut inside it is dropped whole', () => {
    assert.deepStrictEqual(salvageSettings('{"limits": {"read": 1, "write": [1, 2]}, "allowedDirectories": ["/a", "/b"], "x": {"y": 1, "z"'),
      { limits: { read: 1, write: [1, 2] }, allowedDirectories: ['/a', '/b'] });
    assert.deepStrictEqual(salvageSettings('{"telemetryEnabled": false, "limits": {"read": 1, "write": 2'), { telemetryEnabled: false },
      'a nested object cut short is not kept in part');
    assert.deepStrictEqual(salvageSettings('{"path": "C:\\\\dir\\"x", "a": {"b": "}"}, "c": 1'), { path: 'C:\\dir"x', a: { b: '}' } },
      'escaped quotes and braces inside strings are skipped');
  });

  // 6. While running: defaults, then the settings last read, then the readable ones
  await check('while running: the settings last read come between the defaults and the readable settings', () => {
    const lastRead = {
      ...DEFAULTS, allowedDirectories: ['/old'], telemetryEnabled: false, fileReadLineLimit: 200,
      clientId: 'abc', version: '0.2.48', pendingWelcomeOnboarding: true,
    };
    const lastReadBefore = structuredClone(lastRead);
    const passedDefaults = defaults();
    const config = buildRecoveredConfig(passedDefaults, lastRead, '{"allowedDirectories": ["/new"], "fileReadLineLimit": 5');
    assert.deepStrictEqual(config, {
      ...DEFAULTS, allowedDirectories: ['/new'], telemetryEnabled: false, fileReadLineLimit: 200, clientId: 'abc',
      welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false,
    });
    assert(!('version' in config), 'the version last read is not written back');
    assert.deepStrictEqual([passedDefaults, lastRead], [DEFAULTS, lastReadBefore], 'the defaults and the settings last read are not changed');
  });

  if (failures.length > 0) {
    console.log(`${failures.length} of ${total} cases failed`);
    return false;
  }
  return true;
}

runIfMain(import.meta.url, run);

export default run;
