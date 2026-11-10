// Fixed public-fixture diagnostic. This is not a command authorization API.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REVISION = 'ea3ed35a7be9f2a3ea3e89185ff9bbb03fe5ab57';
const PINS = Object.freeze({
  'upstream/command-manager.ts': '43d8badc0218b8da1ceb73de02ad99158bdce8cd1ae21d46ea1aef1af922f3ba',
  'upstream/LICENSE': 'e77cff545e0506903bf6a4bf29169fa40911eb76d70d239267df10c5c59370dd',
  'fixtures.json': '543fa5911dab6ba7de9c808a608cd44e2db7349b302e4316960002d6b9218482'
});

// Compare every observation with its pinned diagnostic oracle. A novel result
// is an error, never evidence that a command should be allowed or a fix works.
export function assertKnownObservations(observations, definitions) {
  if (!Array.isArray(observations) || observations.length !== definitions.fixtures.length) {
    throw new Error('OBSERVATION_COUNT_MISMATCH');
  }
  const fixtures = new Map(definitions.fixtures.map(fixture => [fixture.id, fixture]));
  const seen = new Set();
  for (const observed of observations) {
    const fixture = fixtures.get(observed?.id);
    if (!fixture) throw new Error(`UNKNOWN_OBSERVATION_ID:${observed?.id}`);
    if (seen.has(observed.id)) throw new Error(`DUPLICATE_OBSERVATION_ID:${observed.id}`);
    seen.add(observed.id);
    if (Object.keys(observed).sort().join(',') !== 'commands,denied,id'
      || JSON.stringify(observed.commands) !== JSON.stringify(fixture.observedBaselineCommands)
      || observed.denied !== fixture.observedBaselineDenied) {
      throw new Error(`UNEXPECTED_OBSERVATION:${observed.id}`);
    }
  }
}

export async function verifyDiagnostic({ root = ROOT } = {}) {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('NODE_24_REQUIRED');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.upstreamRevision !== REVISION
    || manifest.fixtureCount !== 16 || manifest.nodeMajor !== 24
    || JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(Object.keys(PINS).sort())
    || Object.entries(PINS).some(([name, hash]) => manifest.files[name] !== hash)) {
    throw new Error('MANIFEST_PIN_MISMATCH');
  }

  const contents = {};
  for (const [name, expectedHash] of Object.entries(PINS)) {
    const bytes = await fs.readFile(path.join(root, name));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) {
      const code = name === 'upstream/command-manager.ts' ? 'SOURCE_HASH_MISMATCH'
        : name === 'fixtures.json' ? 'FIXTURE_HASH_MISMATCH' : 'LICENSE_HASH_MISMATCH';
      throw new Error(code);
    }
    contents[name] = bytes.toString('utf8');
  }
  const definitions = JSON.parse(contents['fixtures.json']);

  // Only TypeScript syntax and the three dependency imports / one export are
  // removed in memory. The pinned source bytes and method bodies stay intact.
  let source = stripTypeScriptTypes(contents['upstream/command-manager.ts'], { mode: 'strip' });
  const imports = [
    "import path from 'path';",
    "import {configManager} from './config-manager.js';",
    'import {capture} from "./utils/capture.js";'
  ];
  for (const declaration of imports) {
    if (!source.includes(declaration)) throw new Error('UNEXPECTED_IMPORT_LAYOUT');
    source = source.replace(declaration, '');
  }
  source = source.replace('export const commandManager = new CommandManager();',
    'const commandManager = new CommandManager();');

  // Node's pure win32.basename helper is the only host function exposed to the
  // parser realm. No filesystem, process, module loader, network, or handler is
  // passed to that realm. This isolates pinned trusted source; node:vm is not
  // a security sandbox for arbitrary or untrusted code.
  const context = vm.createContext({
    __basename: path.win32.basename,
    __fixtureJson: JSON.stringify(definitions)
  }, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate'
  });
  const prelude = `
    const path = Object.freeze({ basename: __basename });
    delete globalThis.__basename;
    const fixtureData = JSON.parse(__fixtureJson);
    delete globalThis.__fixtureJson;
    const telemetry = [];
    const capture = (...args) => telemetry.push(args);
    const console = Object.freeze({ error: (...args) => telemetry.push(args) });
    const configManager = Object.freeze({
      async getConfig() { return { blockedCommands: [...fixtureData.blockedCommands] }; }
    });
    let stringsBlocked = false;
    let wasmBlocked = false;
    try { Function('return 1'); } catch (error) { stringsBlocked = error instanceof EvalError; }
    try { new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])); }
      catch (error) { wasmBlocked = error instanceof WebAssembly.CompileError; }
    const isolation = {
      processAvailable: typeof process !== 'undefined',
      requireAvailable: typeof require !== 'undefined',
      fetchAvailable: typeof fetch !== 'undefined',
      stringCodeGenerationBlocked: stringsBlocked,
      wasmCodeGenerationBlocked: wasmBlocked
    };
  `;
  // This runner is static JavaScript. Fixture strings are arguments to parser
  // methods; they are never concatenated into a Script or sent to a shell.
  const runner = `
    globalThis.__resultJson = null;
    globalThis.__diagnosticError = null;
    (async () => {
      const observations = [];
      for (const fixture of fixtureData.fixtures) {
        observations.push({
          id: fixture.id,
          commands: commandManager.extractCommands(fixture.input),
          denied: !(await commandManager.validateCommand(fixture.input))
        });
      }
      isolation.telemetryEvents = telemetry.length;
      globalThis.__resultJson = JSON.stringify({ observations, isolation });
    })().catch(() => { globalThis.__diagnosticError = 'PARSER_DIAGNOSTIC_ERROR'; });
  `;
  new vm.Script(prelude + '\n' + source + '\n' + runner, {
    filename: 'unchanged-public-parser-diagnostic.js'
  }).runInContext(context, { timeout: 1000 });

  if (context.__diagnosticError || typeof context.__resultJson !== 'string') {
    throw new Error(context.__diagnosticError ?? 'PARSER_DIAGNOSTIC_INCOMPLETE');
  }
  const { observations, isolation } = JSON.parse(context.__resultJson);
  if (isolation.processAvailable || isolation.requireAvailable || isolation.fetchAvailable
    || !isolation.stringCodeGenerationBlocked || !isolation.wasmCodeGenerationBlocked
    || isolation.telemetryEvents !== 0) {
    throw new Error('DIAGNOSTIC_BOUNDARY_MISMATCH');
  }
  assertKnownObservations(observations, definitions);

  const count = kind => definitions.fixtures.filter(fixture => fixture.kind === kind).length;
  return {
    diagnosticStatus: 'BUG_REPRODUCED',
    harnessStatus: 'EXPECTED_OBSERVATIONS_CONFIRMED',
    interpretation: 'Exit 0 confirms the expected reproduction, including known defects. It does not mean the parser is fixed or safe.',
    nodeVersion: process.versions.node,
    upstreamRevision: REVISION,
    sourceSha256: PINS['upstream/command-manager.ts'],
    counts: {
      total: observations.length,
      literalFalsePositivesReproduced: count('literal_false_positive'),
      blockedControlsDenied: count('blocked_control'),
      ordinaryLiteralMatches: count('literal_match'),
      legacyFalseAcceptsRecorded: count('legacy_gap')
    },
    fixtureExecution: 'NONE',
    nativePowerShell: 'UNRUN',
    fullPackageBuild: 'UNRUN',
    securityCertification: false,
    isolation,
    observations: observations.map(observed => {
      const fixture = definitions.fixtures.find(item => item.id === observed.id);
      return {
        id: observed.id,
        kind: fixture.kind,
        expectedPowerShellCommands: fixture.expectedPowerShellCommands,
        expectedPowerShellDenied: fixture.expectedPowerShellDenied,
        observedBaselineCommands: observed.commands,
        observedBaselineDenied: observed.denied
      };
    })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('NO_ARGUMENTS_ACCEPTED');
    console.log(JSON.stringify(await verifyDiagnostic(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ diagnosticStatus: 'REFUSED', reason: error.message }));
    process.exitCode = 1;
  }
}
