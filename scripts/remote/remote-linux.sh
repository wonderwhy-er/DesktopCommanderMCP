#!/bin/sh
# Keep the whole launcher in a subshell so a piped download is parsed before it runs.
# The subshell also keeps PATH changes out of the terminal that started it.
(
    # Prepare: stop on failed commands (-e) or unset variables (-u).
    set -eu

    fail() {
        printf 'Error: %s\n' "$*" >&2
        exit 1
    }

    if [ "$(uname -s)" != Linux ]; then
        fail 'Use remote-macos.sh on macOS or remote-windows.ps1 on Windows.'
    fi

    # Find Node: prefer the user's PATH, then check the standard installation directory.
    # Node's default installation prefix: https://github.com/nodejs/node/blob/v24.x/configure.py (the --prefix option).
    install_prefix=/usr/local
    # command -v checks PATH; redirecting both output streams keeps this test quiet.
    if ! command -v node >/dev/null 2>&1; then
        PATH="$PATH:$install_prefix/bin"
        export PATH

        # Install only when neither location has Node; existing versions are validated below.
        if ! command -v node >/dev/null 2>&1; then
            # Check prerequisites: map the machine's architecture to the official archive name.
            case "$(uname -m)" in
                aarch64|arm64)
                    arch=arm64
                    ;;
                x86_64)
                    arch=x64
                    ;;
                *)
                    fail 'Automatic installation supports x64 and ARM64 Linux with glibc. Install Node.js manually on other systems.'
                    ;;
            esac
            for tool in curl tar sha256sum awk mktemp; do
                if ! command -v "$tool" >/dev/null 2>&1; then
                    fail "Required tool is missing: $tool"
                fi
            done

            # Prepare downloads: use a unique temporary directory and remove it on exit.
            # ${TMPDIR:-/tmp} uses /tmp when TMPDIR is unset or empty; trap 0 runs on exit.
            temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/dc-node-XXXXXX")
            trap 'rm -rf "$temp_dir"' 0
            trap 'exit 130' INT # Shell signal status: 128 + SIGINT (2).
            trap 'exit 143' TERM # Shell signal status: 128 + SIGTERM (15).
            trap 'exit 129' HUP # Shell signal status: 128 + SIGHUP (1).

            # Select the latest Node 24 archive from the checksum manifest's filename column ($2).
            curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt \
                -o "$temp_dir/SHASUMS256.txt"
            archive=$(
                awk -v arch="$arch" '
                    $2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.gz$") {
                        print $2
                    }
                ' "$temp_dir/SHASUMS256.txt"
            )
            if [ -z "$archive" ]; then
                fail 'No matching Node.js download was found.'
            fi

            # Remove the filename prefix (#) and suffix (%) to get the download's version directory.
            version=${archive#node-}
            version=${version%-linux-*}
            printf 'Installing Node.js %s in %s. Administrator access may be requested.\n' \
                "$version" "$install_prefix"

            # Download and verify: check the selected archive before requesting administrator access.
            curl -fsSL "https://nodejs.org/dist/$version/$archive" \
                -o "$temp_dir/$archive"
            awk -v archive="$archive" '
                $2 == archive { print }
            ' "$temp_dir/SHASUMS256.txt" > "$temp_dir/checksum.txt"
            if ! (
                cd "$temp_dir" && sha256sum -c checksum.txt
            ); then
                fail 'Node.js checksum verification failed.'
            fi

            # Install in a subshell so the caller's umask is restored before npx starts.
            (
                # POSIX umask: deny group/other write (0020 + 0002), keeping Node usable system-wide without changing the caller's mask.
                umask 022
                mkdir "$temp_dir/node"

                # Drop the archive's outer directory and test the binary before writing system files.
                tar -xzf "$temp_dir/$archive" \
                    -C "$temp_dir/node" \
                    --strip-components=1
                if ! "$temp_dir/node/bin/node" --version >/dev/null; then
                    fail 'This Node.js build cannot run on your OS. Install a supported Node.js version manually.'
                fi

                # Copy only Node's installation directories; do not change unrelated system files.
                if [ "$(id -u)" = 0 ]; then
                    mkdir -p "$install_prefix"
                    cp -R \
                        "$temp_dir/node/bin" \
                        "$temp_dir/node/include" \
                        "$temp_dir/node/lib" \
                        "$temp_dir/node/share" \
                        "$install_prefix"
                else
                    if ! command -v sudo >/dev/null 2>&1; then
                        fail 'sudo is required to install Node.js. Install Node.js manually and retry.'
                    fi
                    # sudo reads passwords from /dev/tty even when this script is piped to sh.
                    sudo mkdir -p "$install_prefix"
                    sudo cp -R \
                        "$temp_dir/node/bin" \
                        "$temp_dir/node/include" \
                        "$temp_dir/node/lib" \
                        "$temp_dir/node/share" \
                        "$install_prefix"
                fi
            )

            # Clean up: remove successful downloads and clear the now-unneeded exit/signal traps.
            rm -rf "$temp_dir"
            trap - 0 INT TERM HUP
        fi
    fi

    # Validate: report an incomplete installation or unsupported version instead of replacing it.
    if ! command -v node >/dev/null 2>&1; then
        fail 'Node.js installation did not provide node. Install Node.js manually and retry.'
    fi
    if ! node -e '
        const [major, minor] = process.versions.node.split(".").map(Number);
        // Package engines require Node >=22.12.0: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander
        const supported = major > 22 || (major === 22 && minor >= 12);
        process.exit(supported ? 0 : 1);
    '; then
        fail 'Node.js 22.12+ is required. Upgrade your existing Node.js installation and rerun this command.'
    fi
    if ! command -v npx >/dev/null 2>&1; then
        fail 'npx is missing. Install npm for your existing Node.js installation and retry.'
    fi

    # Start as the original user: --yes accepts npm's package-download prompt.
    printf 'Starting Desktop Commander with Node.js %s. Press Ctrl+C to stop; rerun this command to start again.\n' \
        "$(node --version)"
    # -t 0 checks whether stdin is a terminal. A curl | sh pipe needs /dev/tty for interactive input.
    # The isolated ':' command checks that /dev/tty can be opened without consuming any input.
    # exec replaces this launcher process, preserving the device command's exit status and Ctrl+C behavior.
    if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
        exec npx --yes @wonderwhy-er/desktop-commander@latest remote </dev/tty
    fi
    exec npx --yes @wonderwhy-er/desktop-commander@latest remote
)
