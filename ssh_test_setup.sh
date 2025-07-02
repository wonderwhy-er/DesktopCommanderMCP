#!/bin/bash
# SSH Testing Script for Immediate Detection

echo "=== SSH + Desktop Commander Immediate Detection Test ==="
echo ""

echo "🐳 Setting up Docker SSH test environment..."

# Clean up any existing containers
docker stop ssh-test 2>/dev/null || true
docker rm ssh-test 2>/dev/null || true

echo "📦 Starting SSH-enabled container..."
# Use a pre-built SSH container
docker run -d --name ssh-test \
    -p 2222:22 \
    -e SSH_USERS="testuser:12345:1000" \
    -e SSH_ENABLE_ROOT=true \
    -e SSH_ENABLE_PASSWORD_AUTH=true \
    lscr.io/linuxserver/openssh-server:latest

echo "⏳ Waiting for SSH server to start..."
sleep 10

echo "🔧 Installing Python in container..."
docker exec ssh-test apk add --no-cache python3

echo ""
echo "🧪 SSH Connection Test Ideas:"
echo ""
echo "Manual Test Commands:"
echo "1. ssh -p 2222 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no testuser@localhost"
echo "   Password: 12345"
echo ""
echo "2. Test immediate detection with:"
echo "   start_process('ssh -p 2222 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no testuser@localhost', timeout_ms=10000)"
echo ""
echo "3. Once connected, test Python:"
echo "   interact_with_process(pid, 'python3', timeout_ms=8000)"
echo ""
echo "4. Test calculations:"
echo "   interact_with_process(pid, '2 + 3', timeout_ms=5000)"
echo ""

echo "🎯 Expected Behavior:"
echo "- SSH connection should establish quickly"
echo "- Python REPL should start with immediate >>> detection"
echo "- Commands should return immediately despite long timeouts"
echo "- Should see same ~50-100ms performance as local tests"
echo ""

echo "🧹 Cleanup command when done:"
echo "docker stop ssh-test && docker rm ssh-test"
echo ""

echo "✅ SSH test environment ready!"
echo "Container IP: $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ssh-test)"
echo "SSH Port: 2222"
echo "Username: testuser"
echo "Password: 12345"