#!/bin/bash

# Exit on error
set -e

# Function to print error
print_error() {
    echo "❌ Error: $1" >&2
}

# Function to print success
print_success() {
    echo "✅ $1"
}

# Check if Node.js is installed
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d 'v' -f 2)
    NODE_MAJOR_VERSION=$(echo "$NODE_VERSION" | cut -d '.' -f 1)

    if [ "$NODE_MAJOR_VERSION" -lt 18 ]; then
        print_error "Detected Node.js v$NODE_VERSION, but v18+ is required. Please upgrade Node.js."
        exit 1
    else
        echo "Node.js v$NODE_VERSION detected. Continuing..."
    fi
else
    echo "Node.js not found. Installing Node.js v22.14.0..."

    mkdir -p /tmp/nodejs-install
    curl -fsSL -o /tmp/nodejs-install/node-v22.14.0.pkg https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg
    sudo installer -pkg /tmp/nodejs-install/node-v22.14.0.pkg -target /

    if command -v node &> /dev/null; then
        rm -rf /tmp/nodejs-install
        print_success "Node.js v22.14.0 installed successfully."
    else
        print_error "Node.js installation failed. Visit https://nodejs.org to install manually."
        exit 1
    fi
fi

# Run the setup
echo "Running setup command..."
if npx @wonderwhy-er/desktop-commander@latest setup; then
    print_success "Setup completed successfully!"
else
    print_error "Setup failed. Check the console output above for more information."
    exit 1
fi

exit 0
