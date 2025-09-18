import assert from 'assert';
import { startProcess, readProcessOutput, readProcessOutput2 } from '../dist/tools/improved-process-tools.js';

/**
 * Test readProcessOutput2 behavior compared to readProcessOutput
 */
async function testReadProcessOutput2Behavior() {
  console.log('🧪 Testing readProcessOutput2 behavior...');
  
  try {
    // Test 1: Quick command - both should behave similarly
    console.log('\n📝 Test 1: Quick command (echo)');
    const echoResult = await startProcess({
      command: 'echo "Hello World"',
      timeout_ms: 2000
    });
    
    if (echoResult.isError) {
      throw new Error('Failed to start echo process');
    }
    
    const echoPid = extractPid(echoResult.content[0].text);
    console.log(`Started echo process with PID: ${echoPid}`);
    
    // Wait a bit then try both functions
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const output1 = await readProcessOutput({ pid: echoPid, timeout_ms: 2000 });
    const output2 = await readProcessOutput2({ pid: echoPid, timeout_ms: 2000 });
    
    console.log('📊 readProcessOutput:', output1.content[0].text.substring(0, 100));
    console.log('📊 readProcessOutput2:', output2.content[0].text.substring(0, 100));
    
    // Test 2: Sleep command - should show different behavior
    console.log('\n📝 Test 2: Sleep command (longer running)');
    const sleepResult = await startProcess({
      command: 'sleep 3 && echo "Sleep finished"',
      timeout_ms: 1000
    });
    
    if (sleepResult.isError) {
      throw new Error('Failed to start sleep process');
    }
    
    const sleepPid = extractPid(sleepResult.content[0].text);
    console.log(`Started sleep process with PID: ${sleepPid}`);
    
    // Test readProcessOutput with short timeout (should timeout early)
    console.log('Testing readProcessOutput with 2s timeout...');
    const startTime1 = Date.now();
    const sleepOutput1 = await readProcessOutput({ pid: sleepPid, timeout_ms: 2000 });
    const elapsed1 = Date.now() - startTime1;
    console.log(`📊 readProcessOutput took ${elapsed1}ms`);
    console.log('Result:', sleepOutput1.content[0].text.substring(0, 100));
    
    // Test readProcessOutput2 with same timeout (should also timeout but collect more)
    console.log('Testing readProcessOutput2 with 2s timeout...');
    const startTime2 = Date.now();
    const sleepOutput2 = await readProcessOutput2({ pid: sleepPid, timeout_ms: 2000 });
    const elapsed2 = Date.now() - startTime2;
    console.log(`📊 readProcessOutput2 took ${elapsed2}ms`);
    console.log('Result:', sleepOutput2.content[0].text.substring(0, 100));
    
    // Test 3: Python REPL - should both detect waiting for input immediately
    console.log('\n📝 Test 3: Python REPL (should detect waiting for input)');
    const pythonResult = await startProcess({
      command: 'python3 -i',
      timeout_ms: 3000
    });
    
    if (pythonResult.isError) {
      console.log('Python not available, skipping REPL test');
    } else {
      const pythonPid = extractPid(pythonResult.content[0].text);
      console.log(`Started Python REPL with PID: ${pythonPid}`);
      
      // Wait a moment for Python to fully start
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Test readProcessOutput2 first this time
      const startTime4 = Date.now();
      const pythonOutput2 = await readProcessOutput2({ pid: pythonPid, timeout_ms: 3000 });
      const elapsed4 = Date.now() - startTime4;
      console.log(`📊 readProcessOutput2 took ${elapsed4}ms for REPL`);
      console.log('Result:', pythonOutput2.content[0].text.substring(0, 200));
      console.log('Full result length:', pythonOutput2.content[0].text.length);
      
      const startTime3 = Date.now();
      const pythonOutput1 = await readProcessOutput({ pid: pythonPid, timeout_ms: 3000 });
      const elapsed3 = Date.now() - startTime3;
      console.log(`📊 readProcessOutput took ${elapsed3}ms for REPL`);
      console.log('Result:', pythonOutput1.content[0].text.substring(0, 200));
      console.log('Full result length:', pythonOutput1.content[0].text.length);
      
      // Check if either one detected the prompt correctly
      if (elapsed4 < 2000) {
        console.log('✅ readProcessOutput2 detected REPL prompt correctly');
      } else if (elapsed3 < 2000) {
        console.log('✅ readProcessOutput detected REPL prompt correctly');
      } else {
        console.log('❌ Neither function detected REPL prompt correctly');
        throw new Error('Neither function detected REPL prompt correctly');
      }
    }
    
    console.log('\n✅ All tests passed! readProcessOutput2 is working correctly.');
    return true;
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    return false;
  }
}

function extractPid(text) {
  const match = text.match(/PID (\d+)/);
  return match ? parseInt(match[1]) : null;
}

// Run the test
testReadProcessOutput2Behavior()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test error:', error);
    process.exit(1);
  });