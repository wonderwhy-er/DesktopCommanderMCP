// Testing ESLint diagnostics

// Wrong quotes (should be single quotes)
const message = "Hello World"

// Missing semicolon above

// Unused variable
const unused = 42;

// No const reassignment
let mutable = 10
mutable = 20

console.log(message);
console.log(mutable);