#!/bin/bash

# Quick test script - no browser needed!

echo "🧪 Testing OAuth Flow Programmatically..."
echo ""

# Start servers in background
echo "Starting servers..."
node auth-server.js > /dev/null 2>&1 &
AUTH_PID=$!
node resource-server.js > /dev/null 2>&1 &
RESOURCE_PID=$!

# Wait for servers to start
sleep 2

echo "✅ Servers started"
echo ""

# Step 1: Get auth server metadata
echo "1️⃣  Fetching auth server metadata..."
curl -s http://localhost:3001/.well-known/oauth-authorization-server | jq .
echo ""

# Step 2: Simulate user login (skip browser)
echo "2️⃣  Simulating user login..."
CODE=$(curl -s -X POST http://localhost:3001/authorize \
  -d "username=admin" \
  -d "password=password123" \
  -d "client_id=test-client" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "state=test123" \
  | grep -o 'code=[^&]*' | cut -d= -f2)

if [ -z "$CODE" ]; then
  echo "❌ Failed to get authorization code"
  kill $AUTH_PID $RESOURCE_PID
  exit 1
fi

echo "✅ Got authorization code: $CODE"
echo ""

# Step 3: Exchange code for token
echo "3️⃣  Exchanging code for access token..."
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3001/token \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"client_id\":\"test-client\",\"redirect_uri\":\"http://localhost:3000/callback\"}")

ACCESS_TOKEN=$(echo $TOKEN_RESPONSE | jq -r .access_token)

if [ "$ACCESS_TOKEN" = "null" ]; then
  echo "❌ Failed to get access token"
  echo "Response: $TOKEN_RESPONSE"
  kill $AUTH_PID $RESOURCE_PID
  exit 1
fi

echo "✅ Got access token: ${ACCESS_TOKEN:0:20}..."
echo ""

# Step 4: Call protected resource
echo "4️⃣  Calling protected resource with token..."
RESULT=$(curl -s -X POST http://localhost:3002/mcp/tools \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool_name":"test_tool"}')

echo "Response:"
echo $RESULT | jq .
echo ""

# Step 5: Try without token
echo "5️⃣  Trying without token (should fail)..."
curl -s -X POST http://localhost:3002/mcp/tools \
  -H "Content-Type: application/json" \
  -d '{"tool_name":"test_tool"}' | jq .
echo ""

# Cleanup
echo "🧹 Cleaning up..."
kill $AUTH_PID $RESOURCE_PID

echo ""
echo "✅ OAuth flow test complete!"
