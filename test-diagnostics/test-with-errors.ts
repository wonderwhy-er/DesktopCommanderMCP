// Testing diagnostics in a project with tsconfig.json
function greet(name: string): string {
    // Type error: number is not assignable to string
    return 123; // This should show a TypeScript error!
}

// Missing type annotations (strict mode error)
function add(a, b) {
    return a + b;
}

// ESLint issues
const message = "Hello World"  // Missing semicolon, wrong quotes

// Type error
const count: number = "five";

// Unused variable
const unused = 42;

// Typo in console
consol.log(message);

export { greet, add };