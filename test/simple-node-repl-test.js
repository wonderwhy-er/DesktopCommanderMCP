
import { replManager } from '../dist/repl-manager.js';

async function testNodeREPL() {
  try {
    console.log('Creating a Node.js REPL session...');
    const pid = await replManager.createSession('node', 5000);
    console.log(`Created Node.js REPL session with PID ${pid}`);
    
    console.log('Executing a simple Node.js command...');
    const result = await replManager.executeCode(pid, 'console.log("Hello from Node.js!")', {
      waitForPrompt: true,
      timeout: 5000
    });
    console.log(`Result: ${JSON.stringify(result)}`);
    
    console.log('Executing a multi-line Node.js code block...');
    const nodeCode = `
function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet("World"));
`;
    
    const result2 = await replManager.executeCode(pid, nodeCode, { 
      multiline: true,
      timeout: 10000,
      waitForPrompt: true
    });
    console.log(`Multi-line result: ${JSON.stringify(result2)}`);
    
    console.log('Terminating the session...');
    const terminated = await replManager.terminateSession(pid);
    console.log(`Session terminated: ${terminated}`);
    
    console.log('Test completed successfully');
  } catch (error) {
    console.error(`Test failed with error: ${error.message}`);
  }
}

testNodeREPL();
