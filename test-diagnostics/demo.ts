// This file has intentional errors to demonstrate diagnostics

function greet(name: string): string {
    // TypeScript error: number is not assignable to string
    return 123;
}

// TypeScript error: Parameter 'age' implicitly has an 'any' type
function calculateAge(birthYear, currentYear) {
    return currentYear - birthYear;
}

// ESLint errors: wrong quotes and missing semicolon
const message = "Hello World"

// TypeScript error: Cannot find name 'console'
consol.log(message);

// Unused variable (ESLint warning)
const unusedVar = 42;

// Type error: string is not assignable to number
const count: number = "five";

export { greet, calculateAge };