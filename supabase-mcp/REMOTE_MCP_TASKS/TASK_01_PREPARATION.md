# Task 01: Code Preparation & Refactoring

## Objective
Prepare the codebase for remote MCP functionality by removing redundancy and decomposing complex functions without breaking current functionality.

## Scope
- Remove unused/redundant code
- Simplify PKCE storage to use Supabase
- Merge duplicate endpoints
- Extract complex OAuth handlers into separate modules
- Reduce cyclomatic complexity

## Step-by-Step Implementation

### 1. Remove Unused SSE References
- Delete references to non-existent `sse-connector.js` in test files
- Clean up unused imports and variables

### 2. Simplify PKCE Storage
- Move PKCE codes from memory Map to Supabase table
- Create `mcp_pkce_codes` table for persistence
- Update OAuth flow to use database storage

### 3. Merge Duplicate MCP Endpoints
- Combine `/mcp` and `/mcp-direct` into single endpoint
- Simplify authentication handling

### 4. Extract OAuth Components
- Create `src/auth/oauth-validator.js` for parameter validation
- Create `src/auth/oauth-processor.js` for PKCE processing
- Create `src/auth/oauth-responder.js` for redirect handling
- Move complex OAuth logic from main server file

### 5. Extract Session Management
- Create `src/session/session-manager.js` for session coordination
- Create `src/session/transport-factory.js` for transport creation
- Simplify main server constructor

## Acceptance Criteria
- [ ] All existing functionality works unchanged
- [ ] PKCE codes stored in Supabase instead of memory
- [ ] OAuth handlers separated into dedicated modules
- [ ] Session management extracted to separate module
- [ ] Cyclomatic complexity reduced in main server file
- [ ] All tests pass
- [ ] No breaking changes to API endpoints

## Dependencies
None - this is the foundation task

## Estimated Time
4-6 hours