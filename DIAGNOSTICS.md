# Desktop Commander Diagnostics

Desktop Commander now includes VSCode-style diagnostics that provide real-time lint and type error feedback after file operations.

## Overview

When enabled, diagnostics automatically run after `write_file` and `edit_block` operations, showing you:
- TypeScript type errors
- ESLint warnings and errors  
- Python linting (flake8)
- And more through extensible providers

## Quick Start

1. **Enable diagnostics**:
```json
configure_diagnostics {
  "enabled": true
}
```

2. **Write or edit a file** - diagnostics will run automatically and show issues

3. **See the results**:
```
Successfully wrote to example.ts (25 lines)

❌ 2 Errors:
   5:5 - Type 'number' is not assignable to type 'string'. [TS2322] (typescript)
   10:1 - Cannot find name 'consol'. Did you mean 'console'? [TS2552] (typescript)

⚠️  3 Warnings:
   15:7 - 'unused' is assigned a value but never used. [no-unused-vars] (eslint)
   20:1 - Missing semicolon. [semi] (eslint)
```

## Configuration

Use the `configure_diagnostics` tool to customize behavior:

```json
configure_diagnostics {
  "enabled": true,
  "providers": ["typescript", "eslint"],
  "showWarnings": true,
  "showInlineAnnotations": false,
  "maxDiagnostics": 20
}
```

### Options

- **enabled**: `boolean` - Turn diagnostics on/off (default: `false`)
- **providers**: `string[]` - Which providers to use. Empty array means all available (default: `[]`)
- **showWarnings**: `boolean` - Include warnings in output (default: `true`)
- **showInlineAnnotations**: `boolean` - Show inline code annotations (default: `false`)
- **maxDiagnostics**: `number` - Maximum diagnostics to display (default: `20`)

## Available Providers

### Built-in Providers

1. **TypeScript** (`typescript`)
   - File types: `.ts`, `.tsx`, `.mts`, `.cts`
   - Requires: `tsconfig.json` in project
   - Shows: Type errors, compilation issues

2. **ESLint** (`eslint`)
   - File types: `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`
   - Requires: ESLint config file (`.eslintrc.*`, `eslint.config.*`)
   - Shows: Code style issues, potential bugs

3. **Flake8** (`flake8`)
   - File types: `.py`
   - Requires: `flake8` installed
   - Shows: Python style and syntax issues

### List Available Providers

```
list_diagnostic_providers
```

Shows all registered providers and their current status.

## Performance Considerations

- Diagnostics run asynchronously and won't block file operations
- Each provider has a 10-second timeout
- Output is limited to 1MB per provider
- Multiple providers run in parallel
- Results are limited by `maxDiagnostics` setting

## Extending Diagnostics

The diagnostics system is designed to be extensible. You can add custom providers for any linter or type checker.

### Creating a Custom Provider

```typescript
class MyLinterProvider implements DiagnosticProvider {
    name = 'mylinter';
    fileExtensions = ['.my'];
    
    async isAvailable(filePath: string): Promise<boolean> {
        // Check if your linter is available
        return true;
    }
    
    async runDiagnostics(filePath: string): Promise<Diagnostic[]> {
        // Run your linter and return diagnostics
        return [{
            file: filePath,
            line: 10,
            column: 5,
            severity: 'error',
            message: 'Custom linter error',
            source: this.name,
            code: 'CUSTOM001'
        }];
    }
}

// Register the provider
registerDiagnosticProvider(new MyLinterProvider());
```

## Edge Cases Handled

1. **Missing Tools**: If TypeScript or ESLint aren't installed, diagnostics silently skip
2. **Timeouts**: Each provider has a 10-second timeout to prevent hanging
3. **Large Output**: Output is capped at 1MB to prevent memory issues
4. **Many Diagnostics**: Display is limited by `maxDiagnostics` setting
5. **Parse Errors**: Malformed linter output is captured but doesn't crash

## Examples

### TypeScript Project
```bash
# Enable TypeScript diagnostics
configure_diagnostics {"enabled": true, "providers": ["typescript"]}

# Write a file with type errors
write_file {
  "path": "example.ts",
  "content": "function add(a: number): string { return a + 1; }"
}

# See the type error immediately
```

### JavaScript with ESLint
```bash
# Enable ESLint
configure_diagnostics {"enabled": true, "providers": ["eslint"]}

# Edit a file
edit_block {
  "file_path": "app.js",
  "old_string": "console.log('hello')",
  "new_string": "console.log(\"hello\")"  
}

# See ESLint warnings about quote style
```

### Disable for Performance
```bash
# Turn off diagnostics when working with many files
configure_diagnostics {"enabled": false}
```

## Troubleshooting

**No diagnostics showing?**
- Check if diagnostics are enabled: `configure_diagnostics {}`
- Verify the file type is supported
- Ensure required config files exist (tsconfig.json, .eslintrc, etc.)
- Check if the linter is installed in the project

**Too many diagnostics?**
- Reduce `maxDiagnostics`: `configure_diagnostics {"maxDiagnostics": 10}`
- Disable warnings: `configure_diagnostics {"showWarnings": false}`
- Use specific providers: `configure_diagnostics {"providers": ["typescript"]}`

**Performance issues?**
- Disable diagnostics: `configure_diagnostics {"enabled": false}`
- Use fewer providers: `configure_diagnostics {"providers": ["typescript"]}`