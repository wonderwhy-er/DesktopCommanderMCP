# Desktop Commander MCP - Code Style and Conventions

## TypeScript Configuration
- Target: ES2022+
- Modules: ESNext with .js extensions in imports
- Strict mode enabled
- Node.js >= 18.0.0 required

## Code Style
- **Naming Convention**: 
  - camelCase for variables and functions
  - PascalCase for classes and interfaces
  - UPPER_SNAKE_CASE for constants
- **File Organization**:
  - Tools in `src/tools/` directory
  - Handlers in `src/handlers/` directory
  - Utilities in `src/utils/` directory
  - Schemas centralized in `src/tools/schemas.ts`

## Key Patterns
- **Zod Schemas**: All inputs validated with Zod schemas
- **Error Handling**: Comprehensive try-catch with detailed error messages
- **Logging**: Usage tracking and audit logging throughout
- **Type Safety**: Strong TypeScript typing, avoid `any`
- **MCP Protocol**: Follow MCP SDK patterns for tool registration

## Architecture Patterns
- **Tool-based**: Each feature implemented as MCP tools
- **Handler Pattern**: Request handlers separate from tool logic
- **Schema-first**: Define Zod schemas before implementation
- **Async/Await**: Consistent async patterns throughout

## Documentation
- JSDoc comments for public functions
- README.md with comprehensive examples
- Inline comments for complex logic
- Error messages should be user-friendly

## Testing
- Test files in `test/` directory
- Integration tests for MCP tools
- Manual testing with MCP inspector
