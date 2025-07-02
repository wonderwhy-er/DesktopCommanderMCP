## Analysis: Why start_process doesn't return early despite detecting prompts

### Current Issue
The `start_process` function in `terminal-manager.ts` has this logic:

```typescript
setTimeout(() => {
  session.isBlocked = true;
  resolve({
    pid: process.pid!,
    output,
    isBlocked: true
  });
}, timeoutMs);

process.on('exit', (code) => {
  // ... resolve here if process exits
});
```

**The Problem**: Even though the improved-process-tools.ts detects REPL prompts using `analyzeProcessState()`, the actual timeout in `terminal-manager.ts` doesn't use this detection. It blindly waits for the full timeout period.

### Root Cause
1. The `executeCommand` method always waits for the full `timeoutMs` regardless of prompt detection
2. The prompt detection happens AFTER the timeout resolution in the handler layer
3. No early exit mechanism exists in the core terminal manager

## Proposed Strategies

### Strategy 1: Early Exit with Prompt Detection (Recommended)
Modify `terminal-manager.ts` to include prompt detection with periodic checking:

```typescript
async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string): Promise<CommandExecutionResult> {
  // ... existing setup code ...

  return new Promise((resolve) => {
    let resolved = false;
    let checkInterval: NodeJS.Timeout;
    
    const resolveOnce = (result: CommandExecutionResult) => {
      if (resolved) return;
      resolved = true;
      if (checkInterval) clearInterval(checkInterval);
      resolve(result);
    };

    // Data collection
    process.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      session.lastOutput += text;
    });

    process.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      session.lastOutput += text;
    });

    // Periodic prompt detection (every 100ms)
    checkInterval = setInterval(() => {
      if (output.trim()) {
        const state = analyzeProcessState(output, process.pid);
        if (state.isWaitingForInput) {
          session.isBlocked = true;
          resolveOnce({
            pid: process.pid!,
            output,
            isBlocked: true
          });
        }
      }
    }, 100);

    // Timeout fallback
    setTimeout(() => {
      session.isBlocked = true;
      resolveOnce({
        pid: process.pid!,
        output,
        isBlocked: true
      });
    }, timeoutMs);

    // Process exit
    process.on('exit', (code) => {
      // ... existing exit logic ...
      resolveOnce({
        pid: process.pid!,
        output,
        isBlocked: false
      });
    });
  });
}
```

### Strategy 2: Adaptive Timeout with Confidence Levels
Use shorter initial timeout with fallback:

```typescript
async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string): Promise<CommandExecutionResult> {
  // ... setup ...
  
  const isInteractiveCommand = command.includes(' -i') || command.includes('python') || command.includes('node');
  const initialTimeout = isInteractiveCommand ? Math.min(500, timeoutMs) : timeoutMs;
  
  return new Promise((resolve) => {
    let phase = 1;
    let resolved = false;
    
    const checkAndResolve = () => {
      if (resolved) return;
      
      const state = analyzeProcessState(output, process.pid);
      if (state.isWaitingForInput) {
        resolved = true;
        resolve({ pid: process.pid!, output, isBlocked: true });
        return true;
      }
      return false;
    };
    
    // Phase 1: Quick check for interactive prompts
    setTimeout(() => {
      if (checkAndResolve()) return;
      
      // Phase 2: Extended wait if needed
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          session.isBlocked = true;
          resolve({ pid: process.pid!, output, isBlocked: true });
        }
      }, timeoutMs - initialTimeout);
    }, initialTimeout);
    
    // ... data collection and exit handlers ...
  });
}
```

### Strategy 3: Streaming Detection with Debouncing
Detect prompts as data arrives with smart debouncing:

```typescript
async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string): Promise<CommandExecutionResult> {
  // ... setup ...
  
  return new Promise((resolve) => {
    let resolved = false;
    let lastDataTime = Date.now();
    let debounceTimer: NodeJS.Timeout;
    
    const tryResolveWithPrompt = () => {
      if (resolved) return;
      
      const timeSinceData = Date.now() - lastDataTime;
      if (timeSinceData < 200) {
        // Too recent, wait a bit more
        debounceTimer = setTimeout(tryResolveWithPrompt, 200);
        return;
      }
      
      const state = analyzeProcessState(output, process.pid);
      if (state.isWaitingForInput) {
        resolved = true;
        session.isBlocked = true;
        resolve({ pid: process.pid!, output, isBlocked: true });
      }
    };
    
    process.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      session.lastOutput += text;
      lastDataTime = Date.now();
      
      // Clear existing debounce
      if (debounceTimer) clearTimeout(debounceTimer);
      
      // Quick check for obvious prompts
      if (/>>>\s*$|>\s*$/.test(text)) {
        debounceTimer = setTimeout(tryResolveWithPrompt, 100);
      } else {
        debounceTimer = setTimeout(tryResolveWithPrompt, 300);
      }
    });
    
    // ... stderr and timeout handlers ...
  });
}
```

### Strategy 4: Two-Phase Detection System
Separate fast detection for known patterns from comprehensive analysis:

```typescript
const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    let resolved = false;
    
    process.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      session.lastOutput += text;
      
      // Fast path: immediate prompt detection
      if (quickPromptPatterns.test(text)) {
        if (!resolved) {
          resolved = true;
          session.isBlocked = true;
          resolve({ pid: process.pid!, output, isBlocked: true });
          return;
        }
      }
    });
    
    // Slower comprehensive check
    const comprehensiveCheck = setInterval(() => {
      if (resolved) {
        clearInterval(comprehensiveCheck);
        return;
      }
      
      const state = analyzeProcessState(output, process.pid);
      if (state.isWaitingForInput) {
        resolved = true;
        clearInterval(comprehensiveCheck);
        session.isBlocked = true;
        resolve({ pid: process.pid!, output, isBlocked: true });
      }
    }, 250);
    
    // Timeout cleanup
    setTimeout(() => {
      if (!resolved) {
        clearInterval(comprehensiveCheck);
        resolved = true;
        session.isBlocked = true;
        resolve({ pid: process.pid!, output, isBlocked: true });
      }
    }, timeoutMs);
  });
}
```

## Recommended Implementation Order

1. **Start with Strategy 1** - It's the most straightforward and addresses the core issue
2. **Add Strategy 4's fast path** - For immediate detection of obvious prompts  
3. **Consider Strategy 3's debouncing** - If you see issues with partial prompt detection
4. **Use Strategy 2 as fallback** - For specific command types that have predictable behavior

The key insight is that the current system has all the detection logic but doesn't use it in the right place. The timeout resolution needs to happen in `terminal-manager.ts`, not just in the handler layer.