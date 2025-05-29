
import { replManager } from '../dist/repl-manager.js';

async function testBasicREPL() {
  try {
    console.log('Creating a Python REPL session...');
    const pid = await replManager.createSession('python', 5000);
    console.log(`Created Python REPL session with PID ${pid}`);
    
    console.log('Executing a simple Python command...');
    const result = await replManager.executeCode(pid, 'print("Hello from Python!")');
    console.log(`Result: ${JSON.stringify(result)}`);
    
    console.log('Terminating the session...');
    const terminated = await replManager.terminateSession(pid);
    console.log(`Session terminated: ${terminated}`);
    
    console.log('Test completed successfully');
  } catch (error) {
    console.error(`Test failed with error: ${error.message}`);
  }
}

testBasicREPL();
