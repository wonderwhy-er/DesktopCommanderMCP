#!/bin/bash

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Unified MCP OAuth Server with Cloudflare Tunnel${NC}"
echo ""

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}❌ cloudflared not found${NC}"
    echo -e "${YELLOW}Install with: brew install cloudflare/cloudflare/cloudflared${NC}"
    exit 1
fi

# Start server in background
echo -e "${GREEN}📡 Starting unified server on port 3000...${NC}"
node unified-mcp-server.js &
SERVER_PID=$!

# Wait for server to start
sleep 2

# Check if server started
if ! lsof -i :3000 > /dev/null 2>&1; then
    echo -e "${RED}❌ Server failed to start${NC}"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

echo -e "${GREEN}✅ Server running (PID: $SERVER_PID)${NC}"
echo ""

# Start cloudflare tunnel
echo -e "${GREEN}🌐 Starting Cloudflare Tunnel...${NC}"
echo -e "${YELLOW}⏳ This will give you an HTTPS URL in a moment...${NC}"
echo ""

cloudflared tunnel --url http://localhost:3000

# Cleanup on exit
trap "echo ''; echo -e '${YELLOW}🛑 Shutting down...${NC}'; kill $SERVER_PID 2>/dev/null" EXIT
