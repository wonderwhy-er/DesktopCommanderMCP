# Desktop Commander MCP - Task Completion Checklist

## When a Task is Completed

### Code Quality
- [ ] Run `npm run build` to ensure TypeScript compilation succeeds
- [ ] Check for TypeScript errors and warnings
- [ ] Verify imports use correct .js extensions for ESM compatibility
- [ ] Ensure proper error handling with try-catch blocks

### Testing
- [ ] Run `npm run test` to execute integration tests
- [ ] Test manually with `npm run inspector` if needed
- [ ] Verify tool functionality in Claude Desktop

### Schema Validation
- [ ] Update Zod schemas in `src/tools/schemas.ts` if needed
- [ ] Ensure all new parameters are properly validated
- [ ] Test schema validation with invalid inputs

### Documentation
- [ ] Update tool descriptions and examples
- [ ] Add JSDoc comments for new functions
- [ ] Update README.md if new features added

### Version Management
- [ ] Run `npm run bump` for patch versions
- [ ] Run `npm run bump:minor` for new features
- [ ] Run `npm run bump:major` for breaking changes

### Deployment Preparation
- [ ] Ensure `dist/` directory is properly generated
- [ ] Verify all required files are in the `files` array in package.json
- [ ] Test installation with `npm run setup`

### Performance & Logging
- [ ] Check that usage tracking is properly implemented
- [ ] Verify audit logging is working for new tools
- [ ] Test memory usage for large operations

## Before Committing
- [ ] Clean build: `npm run clean && npm run build`
- [ ] All tests pass: `npm run test`
- [ ] No TypeScript errors or warnings
- [ ] Manual testing in Claude Desktop works correctly
