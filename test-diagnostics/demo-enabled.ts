// Test with diagnostics enabled
function test(): string {
    return 123; // Type error: number not assignable to string
}

const unused = "test"; // ESLint warning: unused variable