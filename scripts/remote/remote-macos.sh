#!/bin/sh
# Keep the whole launcher in a subshell so a piped download is parsed before it runs.
(
    set -eu

    fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
    [ "$(uname -s)" = Darwin ] || fail 'Use remote-linux.sh on Linux or remote-windows.ps1 on Windows.'

    # The official macOS installer places Node and npm in /usr/local/bin:
    # https://github.com/nodejs/node/blob/v24.x/tools/macos-installer/productbuild/Resources/en.lproj/welcome.html.tmpl
    install_prefix=/usr/local
    if ! command -v node >/dev/null 2>&1; then
        PATH="$PATH:$install_prefix/bin"
        export PATH
        if ! command -v node >/dev/null 2>&1; then
            case "$(uname -m)" in
                arm64|x86_64) ;;
                *) fail 'Automatic installation supports Apple Silicon and Intel Macs.' ;;
            esac
            for tool in curl shasum awk mktemp installer; do
                command -v "$tool" >/dev/null 2>&1 || fail "Required tool is missing: $tool"
            done

            temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/dc-node-XXXXXX")
            trap 'rm -rf "$temp_dir"' 0
            trap 'exit 130' INT # Shell signal status: 128 + SIGINT (2).
            trap 'exit 143' TERM # Shell signal status: 128 + SIGTERM (15).
            trap 'exit 129' HUP # Shell signal status: 128 + SIGHUP (1).

            curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
            package=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+\.pkg$/ {print $2}' "$temp_dir/SHASUMS256.txt")
            [ -n "$package" ] || fail 'No matching Node.js download was found.'
            version=${package#node-}
            version=${version%.pkg}
            printf 'Installing Node.js %s in %s. Administrator access may be requested.\n' "$version" "$install_prefix"
            curl -fsSL "https://nodejs.org/dist/$version/$package" -o "$temp_dir/$package"
            awk -v package="$package" '$2 == package {print}' "$temp_dir/SHASUMS256.txt" > "$temp_dir/checksum.txt"
            (cd "$temp_dir" && shasum -a 256 -c checksum.txt) || fail 'Node.js checksum verification failed.'
            if [ "$(id -u)" = 0 ]; then
                installer -pkg "$temp_dir/$package" -target /
            else
                command -v sudo >/dev/null 2>&1 || fail 'sudo is required to install Node.js. Install Node.js manually and retry.'
                # sudo reads passwords from /dev/tty even when this script is piped to sh.
                sudo installer -pkg "$temp_dir/$package" -target /
            fi
            rm -rf "$temp_dir"
            trap - 0 INT TERM HUP
        fi
    fi

    command -v node >/dev/null 2>&1 || fail 'Node.js installation did not provide node. Install Node.js manually and retry.'
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
