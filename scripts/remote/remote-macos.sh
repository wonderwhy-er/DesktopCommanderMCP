#!/bin/sh
# Keep the whole launcher in a subshell so a piped download is parsed before it runs.
(
    set -eu

    fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
    [ "$(uname -s)" = Darwin ] || fail 'Use remote-linux.sh on Linux or remote-windows.ps1 on Windows.'

    install_dir="${HOME:?HOME is not set}/.local/share/desktop-commander/node"
    if ! command -v node >/dev/null 2>&1; then
        if [ ! -x "$install_dir/bin/node" ]; then
            [ ! -e "$install_dir" ] || fail "Incomplete Node.js installation at $install_dir. Remove that directory and retry."
            case "$(uname -m)" in
                arm64) arch=arm64 ;;
                x86_64) arch=x64 ;;
                *) fail 'Automatic installation supports Apple Silicon and Intel Macs.' ;;
            esac
            for tool in curl tar shasum awk mktemp; do
                command -v "$tool" >/dev/null 2>&1 || fail "Required tool is missing: $tool"
            done

            mkdir -p "$(dirname "$install_dir")"
            temp_dir=$(mktemp -d "$(dirname "$install_dir")/.node-XXXXXX")
            trap 'rm -rf "$temp_dir"' 0
            trap 'exit 130' INT # Shell signal status: 128 + SIGINT (2).
            trap 'exit 143' TERM # Shell signal status: 128 + SIGTERM (15).
            trap 'exit 129' HUP # Shell signal status: 128 + SIGHUP (1).

            curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
            archive=$(awk -v arch="$arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-darwin-" arch "\\.tar\\.gz$") {print $2}' "$temp_dir/SHASUMS256.txt")
            [ -n "$archive" ] || fail 'No matching Node.js download was found.'
            version=${archive#node-}
            version=${version%-darwin-*}
            printf 'Installing Node.js %s in %s\n' "$version" "$install_dir"
            curl -fsSL "https://nodejs.org/dist/$version/$archive" -o "$temp_dir/$archive"
            awk -v archive="$archive" '$2 == archive {print}' "$temp_dir/SHASUMS256.txt" > "$temp_dir/checksum.txt"
            (cd "$temp_dir" && shasum -a 256 -c checksum.txt) || fail 'Node.js checksum verification failed.'
            mkdir "$temp_dir/node"
            tar -xzf "$temp_dir/$archive" -C "$temp_dir/node" --strip-components=1
            "$temp_dir/node/bin/node" --version >/dev/null || fail 'This Node.js build cannot run on your OS. Install a supported Node.js version manually.'
            mv "$temp_dir/node" "$install_dir"
            rm -rf "$temp_dir"
            trap - 0 INT TERM HUP
        fi
        PATH="$install_dir/bin:$PATH"
        export PATH
    fi

    # Package engines require Node >=22.12.0: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' ||
        fail 'Node.js 22.12+ is required. Upgrade your existing Node.js installation and rerun this command.'
    command -v npx >/dev/null 2>&1 || fail 'npx is missing. Install npm for your existing Node.js installation and retry.'
    printf 'Starting Desktop Commander with Node.js %s. Press Ctrl+C to stop; rerun this command to start again.\n' "$(node --version)"
    # A curl | sh launcher must give the interactive device command its terminal back.
    if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
        exec npx --yes @wonderwhy-er/desktop-commander@latest remote </dev/tty
    fi
    exec npx --yes @wonderwhy-er/desktop-commander@latest remote
)
