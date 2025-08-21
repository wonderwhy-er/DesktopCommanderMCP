# Analysis: What Happens When read_process_output is Called on a Closed Process

## Current Behavior

When `read_process_output` is called on a process that has already exited/closed, the function returns an error:

```
No active session found for PID <pid>
```

## Root Cause

The issue is in `/src/tools/improved-process-tools.ts` in the `readProcessOutput` function around line 110:

```typescript
const session = terminalManager.getSession(pid);
if (!session) {
  return {
    content: [{ type: "text", text: `No active session found for PID ${pid}` }],
    isError: true,
  };
}
```

This check only looks for **active** sessions using `getSession()`, which only checks the `sessions` Map.

## The Problem

However, when a process exits, the `TerminalManager` does two things:
1. **Removes** the session from `sessions` Map (active sessions)
2. **Adds** it to `completedSessions` Map (completed sessions)

The `getNewOutput(pid)` method **can** actually return information about completed sessions:

```typescript
getNewOutput(pid: number): string | null {
  // First check active sessions
  const session = this.sessions.get(pid);
  if (session) {
    const output = session.lastOutput;
    session.lastOutput = '';
    return output;
  }

  // Then check completed sessions  ← THIS PART WORKS!
  const completedSession = this.completedSessions.get(pid);
  if (completedSession) {
    // Format completion message with exit code and runtime
    const runtime = (completedSession.endTime.getTime() - completedSession.startTime.getTime()) / 1000;
    return `Process completed with exit code ${completedSession.exitCode}\nRuntime: ${runtime}s\nFinal output:\n${completedSession.output}`;
  }

  return null;
}
```

## Expected vs Actual Behavior

### Expected:
When calling `read_process_output` on a completed process, it should return the final output and completion status.

### Actual:
It returns an error saying "No active session found".

## Demonstration

```bash
# Start a quick process
start_process("echo 'Hello world'")
# Returns: Process started with PID 15707
# Process immediately completes

# Try to read from it
read_process_output(15707)
# Returns: Error - No active session found for PID 15707
```

## The Fix

The `readProcessOutput` function should be modified to handle completed sessions gracefully:

```typescript
export async function readProcessOutput(args: unknown): Promise<ServerResult> {
  // ... validation code ...

  const { pid, timeout_ms = 5000 } = parsed.data;

  const session = terminalManager.getSession(pid);
  
  // Check if it's an active session
  if (session) {
    // ... existing logic for active sessions ...
  }
  
  // If no active session, check for completed session
  const completedOutput = terminalManager.getNewOutput(pid);
  if (completedOutput) {
    return {
      content: [{
        type: "text",
        text: completedOutput
      }],
    };
  }
  
  // Neither active nor completed
  return {
    content: [{ type: "text", text: `No session found for PID ${pid}` }],
    isError: true,
  };
}
```

## Impact

This change would make the behavior more intuitive and allow users to:
1. Read final output from processes that completed quickly
2. Get completion status and exit codes
3. Avoid confusion about "missing" processes that actually completed
