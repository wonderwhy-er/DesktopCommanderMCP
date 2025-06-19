// Testing TypeScript diagnostics
export function add(a: number, b: number): string {
    // Type error: Type 'number' is not assignable to type 'string'
    return a + b;
}

// Parameter implicitly has 'any' type
export function greet(name) {
    return `Hello ${name}`;
}

// Cannot find name 'consol' (typo)
consol.log('test');