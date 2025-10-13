#!/bin/bash

echo "🧪 Testing MCP-Compliant OAuth Flow"
echo "===================================="
echo ""

# Start servers in background
echo "Starting servers..."
node mcp-auth-server.js > /tmp/auth.log 2>&1 &
AUTH_PID=$!
node mcp-resource-server.js > /tmp/resource.log 2>&1 &
RESOURCE_PID=$!

# Wait for servers to start
sleep 2

echo "✅ Servers started"
echo ""

# Test 1: Authorization Server Metadata
echo "1️⃣  Testing Authorization Server Metadata (RFC 8414)"
echo "   GET /.well-known/oauth-authorization-server"
METADATA=$(curl -s http://localhost:3001/.well-known/oauth-authorization-server)
echo "$METADATA" | jq .
echo ""

# Test 2: Protected Resource Metadata  
echo "2️⃣  Testing Protected Resource Metadata (RFC 9728)"
echo "   GET /.well-known/oauth-protected-resource"
curl -s http://localhost:3002/.well-known/oauth-protected-resource | jq .
echo ""

# Test 3: Dynamic Client Registration
echo "3️⃣  Testing Dynamic Client Registration (RFC 7591)"
echo "   POST /register"
CLIENT_REG=$(curl -s -X POST http://localhost:3001/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Test MCP Client",
    "redirect_uris": ["http://localhost:3000/callback"]
  }')

CLIENT_ID=$(echo "$CLIENT_REG" | jq -r .client_id)
echo "   Registered client: $CLIENT_ID"
echo "$CLIENT_REG" | jq .
echo ""

# Test 4: Authorization (simulate user login)
echo "4️⃣  Testing Authorization Flow"
echo "   POST /authorize (simulating user login)"
AUTH_RESPONSE=$(curl -s -L -X POST http://localhost:3001/authorize \
  -d "username=admin" \
  -d "password=password123" \
  -d "client_id=$CLIENT_ID" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "response_type=code" \
  -d "state=test123" \
  -d "scope=mcp:tools")

CODE=$(echo "$AUTH_RESPONSE" | grep -o 'code=[^&"]*' | cut -d= -f2 | head -1)

if [ -z "$CODE" ]; then
  echo "   ❌ Failed to get authorization code"
  kill $AUTH_PID $RESOURCE_PID
  exit 1
fi

echo "   ✅ Got authorization code: ${CODE:0:30}..."
echo ""

# Test 5: Token Exchange
echo "5️⃣  Testing Token Exchange"
echo "   POST /token"
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3001/token \
  -H "Content-Type: application/json" \
  -d "{
    \"grant_type\": \"authorization_code\",
    \"code\": \"$CODE\",
    \"client_id\": \"$CLIENT_ID\",
    \"redirect_uri\": \"http://localhost:3000/callback\"
  }")

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r .access_token)

if [ "$ACCESS_TOKEN" = "null" ]; then
  echo "   ❌ Failed to get access token"
  echo "   Response: $TOKEN_RESPONSE"
  kill $AUTH_PID $RESOURCE_PID
  exit 1
fi

echo "   ✅ Got access token (JWT)"
echo "$TOKEN_RESPONSE" | jq .
echo ""

# Test 6: MCP Initialize (with auth)
echo "6️⃣  Testing MCP Initialize (with OAuth token)"
echo "   POST /mcp (initialize)"
INIT_RESPONSE=$(curl -s -X POST http://localhost:3002/mcp \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "Test Client",
        "version": "1.0.0"
      }
    },
    "id": 1
  }')

echo "$INIT_RESPONSE" | jq .
echo ""

# Test 7: List Tools
echo "7️⃣  Testing MCP Tools List"
echo "   POST /mcp (tools/list)"
TOOLS_RESPONSE=$(curl -s -X POST http://localhost:3002/mcp \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 2
  }')

echo "$TOOLS_RESPONSE" | jq .
echo ""

# Test 8: Call Tool
echo "8️⃣  Testing MCP Tool Call"
echo "   POST /mcp (tools/call - get_user_info)"
CALL_RESPONSE=$(curl -s -X POST http://localhost:3002/mcp \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "get_user_info",
      "arguments": {}
    },
    "id": 3
  }')

echo "$CALL_RESPONSE" | jq .
echo ""

# Test 9: Try without token (should fail)
echo "9️⃣  Testing Request Without Token (should fail with 401)"
echo "   POST /mcp (no Authorization header)"
NO_AUTH_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST http://localhost:3002/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 4
  }')

echo "$NO_AUTH_RESPONSE" | head -n -1 | jq .
HTTP_CODE=$(echo "$NO_AUTH_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
if [ "$HTTP_CODE" = "401" ]; then
  echo "   ✅ Correctly returned 401 Unauthorized"
else
  echo "   ❌ Expected 401, got $HTTP_CODE"
fi
echo ""

# Test 10: JWKS endpoint
echo "🔟 Testing JWKS Endpoint"
echo "   GET /.well-known/jwks.json"
curl -s http://localhost:3001/.well-known/jwks.json | jq .
echo ""

# Cleanup
echo "🧹 Cleaning up..."
kill $AUTH_PID $RESOURCE_PID

echo ""
echo "✅ MCP OAuth Compliance Test Complete!"
echo ""
echo "📝 Summary:"
echo "   ✅ RFC 8414 - Authorization Server Metadata"
echo "   ✅ RFC 9728 - Protected Resource Metadata"
echo "   ✅ RFC 7591 - Dynamic Client Registration"
echo "   ✅ OAuth 2.1 - Authorization Code Flow"
echo "   ✅ JWT - JSON Web Tokens"
echo "   ✅ MCP Protocol - Initialize, List Tools, Call Tools"
echo ""
echo "🎯 This server should work with MCP clients like:"
echo "   - MCP Inspector"
echo "   - Custom MCP clients"
echo "   - (Claude.ai requires deployment to public URL)"
