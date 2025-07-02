#!/usr/bin/env node

/**
 * Demo of what users will see when feedback prompts appear
 */

import { usageTracker } from './dist/utils/usageTracker.js';

async function demoUserExperience() {
    console.log('📱 DEMO: What Users Will See\n');
    console.log('='.repeat(60));
    
    // Simulate a normal tool response
    console.log('User runs: read_file("/path/to/project/README.md")');
    console.log('');
    console.log('📄 Tool Response:');
    console.log('-'.repeat(40));
    console.log('# My Project\n\nThis is a sample README file with project documentation...\n\n[Content continues for 50+ lines...]');
    
    // Get a feedback message
    const feedbackMessage = await usageTracker.getFeedbackPromptMessage();
    
    // Show how it appears to the user
    console.log(`\n${feedbackMessage}`);
    console.log('-'.repeat(40));
    
    console.log('\n💡 User Experience:');
    console.log('   ✅ Gets their work done first (file read completed)');
    console.log('   ✅ Sees subtle P.S. style message');
    console.log('   ✅ Understands what data is shared');
    console.log('   ✅ Can opt-in to user studies');
    console.log('   ✅ Non-intrusive - work flow not interrupted');
    console.log('   ✅ Only appears every 2+ hours if not responded to');
    
    console.log('\n🔄 If user clicks the feedback link:');
    console.log('   🌐 Browser opens to pre-filled form');
    console.log('   📝 Optional fields - can fill what they want');
    console.log('   📊 Usage stats auto-included for context');
    console.log('   ☎️  Can opt-in to user research calls');
    
    console.log('\n✅ Perfect balance: helpful but never annoying!');
}

demoUserExperience();
