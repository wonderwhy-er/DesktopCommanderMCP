#!/bin/bash

echo "🚀 Starting Minimal OAuth Test Servers..."
echo ""
echo "This will start 3 servers:"
echo "  1. Auth Server (port 3001) - handles login"
echo "  2. Resource Server (port 3002) - Desktop Commander simulation"
echo "  3. Client (port 3000) - test client"
echo ""
echo "Opening in new terminal windows..."
echo ""

# Check if we're on macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - use Terminal
    osascript <<EOF
tell application "Terminal"
    do script "cd $(pwd) && npm run auth-server"
    delay 1
    do script "cd $(pwd) && npm run resource-server"
    delay 1
    do script "cd $(pwd) && npm run client"
    activate
end tell
EOF
else
    echo "⚠️  Auto-opening only works on macOS"
    echo "Please manually open 3 terminals and run:"
    echo "  Terminal 1: npm run auth-server"
    echo "  Terminal 2: npm run resource-server"
    echo "  Terminal 3: npm run client"
fi

echo ""
echo "✅ Once all servers start, open: http://localhost:3000/start"
echo ""
