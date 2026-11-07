# Unchanged parser diagnostic reproduction

This offline kit reproduces quoting defects in an **unchanged public upstream parser**. It contains no correction, replacement validator, process handler, connector integration, or installation steps. All 16 fixture strings are synthetic public examples. **No fixture text is executed.**

Use an existing **Node.js 24.x** installation (verified here with **24.19.0**). No packages, network access, or dependency installation are needed. From this directory, run:

```text
node verify.mjs
```

The launcher accepts no arguments. It checks the bundled source, license, and fixture hashes against fixed pins before loading the parser. Altered inputs, an altered manifest pin, and unknown or incomplete observations cause refusal with a nonzero exit code.

The expected report is `diagnosticStatus: "BUG_REPRODUCED"` and `harnessStatus: "EXPECTED_OBSERVATIONS_CONFIRMED"`. **Exit 0 confirms reproduction of the documented defects; it does not mean the parser is fixed, safe, or suitable for authorization.**

| Fixture group | Count | Semantic expectation | Observed unchanged parser |
|---|---:|---|---|
| Ordinary single-quoted literals, L1–L6 | 6 | Blocked-looking text inside the literal is data | Incorrectly extracts a blocked name and denies all 6 |
| Direct, chained, or expanding blocked-command controls, C1–C6 | 6 | Deny with the synthetic two-name blocklist | Denies all 6 |
| Plain ordinary literals, M1–M2 | 2 | No blocked command name | Accepts both |
| Known invocation gaps, G1–G2 | 2 | Deny the invoked blocked name | Incorrectly accepts both |

The fixture definitions record expected command-name roles separately from the exact observed extraction arrays and boolean decisions. The illustrative blocklist is only `sudo` and `format`; this is not a copy of any live configuration. Command-name roles do not establish executable availability, command resolution, execution order, or permission to run anything.

## Basis for semantic expectations

Microsoft's [PowerShell 5.1 about_Quoting_Rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-5.1) describes ordinary single-quoted strings as verbatim, doubled single quotes as a literal quote, and double-quoted strings as expandable. Therefore backticks and `$()` in L1–L6 remain literal text. In C4–C5, a subexpression is in an expanding context.

Microsoft's [about_Operators](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_operators?view=powershell-5.1) documents the call, dot-sourcing, and subexpression operators. G1 is the quoted call-operator target and G2 is the dot-invocation target. These expectations are documentation-based; they are **not native PowerShell AST or execution results**. Running this offline kit does not fetch either document.

## Diagnostic boundary

The only upstream code is `upstream/command-manager.ts`, copied byte-for-byte from the existing public baseline snapshot of [revision ea3ed35a7be9f2a3ea3e89185ff9bbb03fe5ab57](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/ea3ed35a7be9f2a3ea3e89185ff9bbb03fe5ab57/src/command-manager.ts). Its SHA-256 is:

```text
43d8badc0218b8da1ceb73de02ad99158bdce8cd1ae21d46ea1aef1af922f3ba
```

Node erases TypeScript syntax in memory. The harness removes dependency import declarations and the instance's export keyword, then binds inert configuration and telemetry. It uses Node's pure `path.win32.basename` helper to match the intended path flavor. Parser method bodies and bundled source bytes remain unchanged.

Fixture strings enter only as JSON data and arguments to the parser's text-processing methods. They are never embedded in a JavaScript script or sent to a command interpreter. The parser realm has no exposed process, module loader, filesystem, fetch, terminal, or process handler. VM string and WebAssembly code generation are disabled and checked, with a one-second VM timeout. As the [Node.js VM documentation](https://nodejs.org/docs/latest-v24.x/api/vm.html) explains, `node:vm` is not a security mechanism for untrusted code. This kit uses it only to isolate this pinned, trusted source and inert dependencies. The trusted launcher and its fixed pins are part of the reproduction's trust base.

## Launcher regression checks

```text
node --test --test-isolation=none test/launcher.test.mjs
```

All 10 launcher checks pass in the recorded run. They cover the bounded report, restored input files, altered source, a changed manifest source pin, unknown fixture input, unknown command output, unknown/duplicate fixture identifiers, missing observations, and a changed blocked-control result. Negative cases modify temporary copies only. A separate CLI run from a fresh copy verifies the copied launcher itself. The public verification record describes these checks; historical test-first logs remain with the preparation record.

Node emits the expected `stripTypeScriptTypes` experimental warning. It is retained in node-warning.txt. The launcher returns structured refusal on any unexpected result; it does not adapt or authorize unknown commands.

## Limits

This kit covers 16 fixed examples and two illustrative blocked names. It also records two inherited false accepts; passing launcher checks do not convert them into safe behavior. Aliases, executable suffixes, dynamic command resolution, full PowerShell grammar, other shells, and arbitrary inputs remain unverified.

Native PowerShell parsing and execution, full-package TypeScript/build tests, upstream integration tests, and installed connector behavior are **UNRUN**. No Windows script or alternative execution path is included. No live configuration, access permission, or safeguard is changed. This kit provides reproduction evidence only.
