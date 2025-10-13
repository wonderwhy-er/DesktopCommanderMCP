# OAuth Flow Visualization

## The Simplest Possible OAuth Flow

```
USER                    CLIENT                  AUTH SERVER            RESOURCE SERVER
 |                        |                          |                        |
 |                        |                          |                        |
 |  1. "I want to        |                          |                        |
 |     use the app"      |                          |                        |
 |---------------------->|                          |                        |
 |                        |                          |                        |
 |                        | 2. "Where do I login?"  |                        |
 |                        |------------------------>|                        |
 |                        |                          |                        |
 |                        | 3. "Login at /authorize"|                        |
 |                        |<------------------------|                        |
 |                        |                          |                        |
 | 4. Opens browser      |                          |                        |
 | to auth server        |                          |                        |
 |-------------------------------------------------->|                        |
 |                        |                          |                        |
 | 5. Sees login form    |                          |                        |
 |<--------------------------------------------------|                        |
 |                        |                          |                        |
 | 6. Enters username    |                          |                        |
 |    & password         |                          |                        |
 |-------------------------------------------------->|                        |
 |                        |                          |                        |
 | 7. Redirect with code |                          |                        |
 |<--------------------------------------------------|                        |
 |                        |                          |                        |
 | 8. Browser redirects  |                          |                        |
 |    back to client     |                          |                        |
 |---------------------->|                          |                        |
 |                        |                          |                        |
 |                        | 9. "Give me token       |                        |
 |                        |     for code: ABC123"   |                        |
 |                        |------------------------>|                        |
 |                        |                          |                        |
 |                        | 10. "Here's token:      |                        |
 |                        |      XYZ789"            |                        |
 |                        |<------------------------|                        |
 |                        |                          |                        |
 |                        | 11. "Do thing           |                        |
 |                        |     (token: XYZ789)"    |                        |
 |                        |------------------------------------------------->|
 |                        |                          |                        |
 |                        |                          | 12. "Is token valid?"  |
 |                        |                          |<-----------------------|
 |                        |                          |                        |
 |                        |                          | 13. "Yes, user=admin"  |
 |                        |                          |----------------------->|
 |                        |                          |                        |
 |                        | 14. "Here's the data"   |                        |
 |                        |<-------------------------------------------------|
 |                        |                          |                        |
 | 15. Shows result      |                          |                        |
 |<----------------------|                          |                        |
 |                        |                          |                        |
```

## What Each Component Does

### 🌐 Client (Port 3000)
- Your app (like Claude.ai)
- Wants to access protected resources
- Handles the OAuth dance

### 🔐 Auth Server (Port 3001)
- Knows users (username/password)
- Shows login page
- Issues authorization codes
- Exchanges codes for tokens

### 🛠️ Resource Server (Port 3002)
- Desktop Commander
- Has MCP tools
- Checks if token is valid
- Executes tools if authorized

## The Tokens

### Authorization Code
- **What**: Short-lived temporary code
- **Lifetime**: 1 minute
- **Purpose**: Prove user logged in
- **Example**: `a3f2b9c8d1e4...` (random hex)

### Access Token
- **What**: The actual "key" to access resources
- **Lifetime**: 1 hour
- **Purpose**: Authenticate API calls
- **Example**: `x7y9z2a4b6c8...` (random hex)

## Why Two Steps? (Code → Token)

**Security!**

1. Authorization code goes through **browser** (less secure)
2. Token exchange happens **server-to-server** (more secure)
3. User never sees the actual access token
4. If code is stolen, it expires in 1 minute

## In Real OAuth

In production OAuth (MCP spec), you'd also have:
- **PKCE**: Code challenge/verifier (prevents code theft)
- **JWT**: Token contains signed claims about user
- **Refresh Token**: Get new access token without re-login
- **Scopes**: Fine-grained permissions

But this minimal version **teaches the core concept**!

## Try It!

### Interactive (with browser):
```bash
npm run auth-server    # Terminal 1
npm run resource-server # Terminal 2
npm run client         # Terminal 3

# Then open: http://localhost:3000/start
```

### Automated (no browser):
```bash
./test-flow.sh
```

## Key Takeaways

1. ✅ User logs in to **Auth Server** (not Client!)
2. ✅ Client never sees password
3. ✅ Token is like a temporary key
4. ✅ Resource Server trusts Auth Server's tokens
5. ✅ User can revoke access by invalidating token

This is OAuth! 🎉
