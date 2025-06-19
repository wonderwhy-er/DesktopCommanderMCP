// Testing TypeScript only
function test(): string {
    return 123; // Type error
}

// Missing parameter type
function greet(name) {
    return `Hello ${name}`;
}

// Typo in console
consol.log('test');