#!/bin/bash

echo "🧪 Testing Unified Server - Tools List"
echo ""

# Start server in background
echo "Starting server..."
node unified-mcp-server.js &
SERVER_PID=$!
sleep 2

echo ""
echo "1️⃣ Testing initialize (without auth - should fail):"
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}' | jq .

echo ""
echo "2️⃣ Testing tools/list (without auth - should fail):"
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}' | jq .

echo ""
echo "✅ Both should return 'Authorization required' error"
echo ""

# Cleanup
kill $SERVER_PID 2>/dev/null
echo "Server stopped"
