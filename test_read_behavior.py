#!/usr/bin/env python3
"""
Test script to demonstrate read_process_output behavior on closed processes
"""

import json
import subprocess
import time

def call_mcp_tool(tool_name, params):
    """Call an MCP tool and return the result"""
    # This is a simplified example - in reality you'd use the MCP protocol
    print(f"🔧 Calling {tool_name} with params: {params}")
    
    # Simulate the actual behavior we observed
    if tool_name == "start_process":
        return {"pid": 12345, "output": "Hello world\n"}
    elif tool_name == "read_process_output" and params.get("pid") == 12345:
        return {"error": "No active session found for PID 12345"}
    
    return {"error": "Unknown tool or params"}

def demonstrate_current_behavior():
    """Demonstrate the current problematic behavior"""
    print("=" * 60)
    print("DEMONSTRATING CURRENT BEHAVIOR")
    print("=" * 60)
    
    # Start a quick process
    print("1. Starting a quick process (echo)")
    result1 = call_mcp_tool("start_process", {"command": "echo 'Hello world'"})
    pid = result1.get("pid")
    print(f"   Result: PID {pid}, Output: {result1.get('output', '').strip()}")
    
    # Process has already completed at this point
    print("\n2. Process completes immediately (echo is fast)")
    print("   Process moves from active sessions to completed sessions")
    
    # Try to read from completed process
    print(f"\n3. Attempting to read from completed process (PID {pid})")
    result2 = call_mcp_tool("read_process_output", {"pid": pid})
    if "error" in result2:
        print(f"   ❌ Error: {result2['error']}")
    else:
        print(f"   ✅ Success: {result2}")
    
def demonstrate_proposed_fix():
    """Demonstrate how the proposed fix would work"""
    print("\n" + "=" * 60)
    print("PROPOSED FIX BEHAVIOR")
    print("=" * 60)
    
    print("1. Starting a quick process (echo)")
    print("   Result: PID 12345, Output: Hello world")
    
    print("\n2. Process completes immediately")
    print("   Process moves from active sessions to completed sessions")
    
    print("\n3. Attempting to read from completed process (PID 12345)")
    print("   ✅ Success: Process completed with exit code 0")
    print("   Runtime: 0.1s")
    print("   Final output:")
    print("   Hello world")

def show_code_analysis():
    """Show the code analysis"""
    print("\n" + "=" * 60)
    print("CODE ANALYSIS")
    print("=" * 60)
    
    print("""
The issue is in readProcessOutput function:

CURRENT CODE:
```typescript
const session = terminalManager.getSession(pid);
if (!session) {
  return {
    content: [{ type: "text", text: `No active session found for PID ${pid}` }],
    isError: true,
  };
}
```

PROBLEM:
- getSession() only checks active sessions
- When process completes, it's moved to completedSessions
- But readProcessOutput doesn't check completedSessions

SOLUTION:
```typescript
const session = terminalManager.getSession(pid);
if (session) {
  // Handle active session (existing logic)
} else {
  // Check for completed session
  const completedOutput = terminalManager.getNewOutput(pid);
  if (completedOutput) {
    return { content: [{ type: "text", text: completedOutput }] };
  }
  return { content: [{ type: "text", text: `No session found for PID ${pid}` }], isError: true };
}
```
""")

def main():
    demonstrate_current_behavior()
    demonstrate_proposed_fix() 
    show_code_analysis()
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print("""
❌ CURRENT: read_process_output fails on completed processes
✅ PROPOSED: read_process_output returns completion info for completed processes

This would make the API more user-friendly and intuitive!
""")

if __name__ == "__main__":
    main()
