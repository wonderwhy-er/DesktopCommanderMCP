# Desktop Commander Diagnostics POC Demo

This POC demonstrates VSCode-style lint/type error reporting after file modifications.

## Architecture

The diagnostics system is designed to be:
- **Extensible**: Plugin-based architecture allows adding new diagnostic providers
- **Configurable**: Users can enable/disable diagnostics and choose specific providers
- **Non-intrusive**: Diagnostics are opt-in and don't affect existing functionality

## Key Components

1. **DiagnosticProvider Interface**: Defines the contract for diagnostic providers
2. **DiagnosticProviderRegistry**: Manages registered providers
3. **Built-in Providers**:
   - TypeScript (`typescript`): Type checking for .ts/.tsx files
   - ESLint (`eslint`): Linting for .js/.jsx/.ts/.tsx files
   - Flake8 (`flake8`): Python linting (example of extensibility)

## Configuration

Diagnostics can be configured in the config.json:

```json
{
  "diagnostics": {
    "enabled": true,
    "providers": ["typescript", "eslint"],  // or [] for all
    "showWarnings": true,
    "showInlineAnnotations": false
  }
}
```

## Usage Example

1. Enable diagnostics:
```bash
# Update config to enable diagnostics
# In config.json, set diagnostics.enabled to true
```

2. Write or edit a file with errors:
```typescript
// The file will be written/edited, then diagnostics will run
```

3. See instant feedback:
```
Successfully wrote to demo.ts (24 lines)

━━━ Code Issues ━━━

❌ 4 Errors:
   5:5 - Type 'number' is not assignable to type 'string'. [TS2322] (typescript)
   9:23 - Parameter 'birthYear' implicitly has an 'any' type. [TS7006] (typescript)
   9:34 - Parameter 'currentYear' implicitly has an 'any' type. [TS7006] (typescript)
   17:1 - Cannot find name 'consol'. Did you mean 'console'? [TS2552] (typescript)

⚠️  2 Warnings:
   14:1 - Strings must use singlequote. [quotes] (eslint)
   14:22 - Missing semicolon. [semi] (eslint)
```

## Extending the System

To add a new diagnostic provider:

```typescript
class MyLinterProvider implements DiagnosticProvider {
    name = 'mylinter';
    fileExtensions = ['.my'];
    
    async isAvailable(filePath: string): Promise<boolean> {
        // Check if your linter is available
    }
    
    async runDiagnostics(filePath: string): Promise<Diagnostic[]> {
        // Run your linter and return diagnostics
    }
}

// Register the provider
registerDiagnosticProvider(new MyLinterProvider());
```

## Benefits

1. **Immediate Feedback**: Developers get instant feedback on code issues
2. **Configurable**: Can be disabled for performance or enabled per-project
3. **Extensible**: Community can add support for any linter/checker
4. **Familiar**: Mimics VSCode's diagnostic display format