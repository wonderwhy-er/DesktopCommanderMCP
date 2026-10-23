#!/bin/sh
# Keep the whole launcher in a subshell so a piped download is parsed before it runs.
# The subshell also keeps PATH changes out of the terminal that started it.
(
    # Prepare: stop on failed commands (-e) or unset variables (-u).
    set -eu

    fail() {
        printf 'Error: %s\n' "$1" >&2
        # Keep a failed download or installer's exit status when one is supplied.
        exit "${2:-1}"
    }

    if [ "$(uname -s)" != Linux ]; then
        fail 'This command is for Linux. Please use the setup command for your computer.'
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
            # Map the CPU once for both manual downloads and automatic installation.
            case "$(uname -m)" in
                aarch64|arm64)
                    arch=arm64
                    ;;
                x86_64)
                    arch=x64
                    ;;
                *)
                    arch=
                    ;;
            esac

            # Ask before changing the computer; stdin may still contain the piped script.
            printf '%s\n' \
                'Remote Desktop Commander needs Node.js, which could not be found on this computer.' \
                'If you choose Yes, we will install Node.js 24, then download and start Remote Desktop Commander.'
            if ! ( : </dev/tty ) 2>/dev/null; then
                fail 'We could not read your answer. Please open Terminal and run this command again.'
            fi
            printf '%s' 'Would you like to continue? Type Yes or No (press Enter for No): '
            if ! IFS= read -r answer </dev/tty; then
                answer=
            fi
            case "$answer" in
                [yY]|[yY][eE][sS])
                    ;;
                *)
                    printf '\n%s\n' \
                        'Node.js could not be found. You can choose either option:' \
                        '1. If Node.js is already installed, open a new Terminal window and run:' \
                        'npx @wonderwhy-er/desktop-commander@latest remote'
                    if [ -n "$arch" ]; then
                        # Pin the manual link so declining needs no network lookup and works offline.
                        printf '\n%s\n' \
                            '2. To install Node.js yourself, use this download link:' \
                            "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-$arch.tar.gz" \
                            'After installing Node.js, open a new Terminal window and run the command above.'
                    else
                        printf '\n%s\n' \
                            '2. Browse all Node.js versions and downloads here:' \
                            'https://nodejs.org/en/about/previous-releases'
                    fi
                    exit 0
                    ;;
            esac

            # Check prerequisites only after consent; unsupported CPUs still receive the manual command above.
            if [ -z "$arch" ]; then
                fail 'This computer cannot use the automatic installer. Please install Node.js from https://nodejs.org, then run this command again.'
            fi
            for tool in curl tar sha256sum awk mktemp; do
                if ! command -v "$tool" >/dev/null 2>&1; then
                    fail 'We could not set up Node.js automatically. Please install it from https://nodejs.org, then run this command again.'
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
                -o "$temp_dir/SHASUMS256.txt" 2>/dev/null ||
                fail 'We could not download Node.js. Check your internet connection and try again.' "$?"
            archive=$(
                awk -v arch="$arch" '
                    $2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.gz$") {
                        print $2
                    }
                ' "$temp_dir/SHASUMS256.txt"
            )
            if [ -z "$archive" ]; then
                fail 'We could not find the Node.js download. Please try again later.'
            fi

            # Remove the filename prefix (#) and suffix (%) to get the download's version directory.
            version=${archive#node-}
            version=${version%-linux-*}
            printf '%s\n' 'Installing Node.js...'

            # Download and verify: check the selected archive before requesting administrator access.
            curl -fsSL "https://nodejs.org/dist/$version/$archive" \
                -o "$temp_dir/$archive" 2>/dev/null ||
                fail 'We could not download Node.js. Check your internet connection and try again.' "$?"
            awk -v archive="$archive" '
                $2 == archive { print }
            ' "$temp_dir/SHASUMS256.txt" > "$temp_dir/checksum.txt"
            if ! (
                cd "$temp_dir" && sha256sum -c checksum.txt >/dev/null 2>&1
            ); then
                fail 'The Node.js download could not be verified. Please run this command again to download a fresh copy.'
            fi

            # Install in a subshell so the caller's umask is restored before npx starts.
            (
                # POSIX umask: deny group/other write (0020 + 0002), keeping Node usable system-wide without changing the caller's mask.
                umask 022
                mkdir "$temp_dir/node"

                # Drop the archive's outer directory and test the binary before writing system files.
                tar -xzf "$temp_dir/$archive" \
                    -C "$temp_dir/node" \
                    --strip-components=1 2>/dev/null ||
                    fail 'We could not prepare the Node.js download. Please run this command again.' "$?"
                if ! "$temp_dir/node/bin/node" --version >/dev/null 2>&1; then
                    fail 'This computer cannot run the downloaded Node.js version. Please install a compatible version from https://nodejs.org, then run this command again.'
                fi

                # Copy only Node's installation directories; do not change unrelated system files.
                if [ "$(id -u)" = 0 ]; then
                    mkdir -p "$install_prefix" ||
                        fail 'We could not finish installing Node.js. Please try again, or install it from https://nodejs.org.' "$?"
                    cp -R \
                        "$temp_dir/node/bin" \
                        "$temp_dir/node/include" \
                        "$temp_dir/node/lib" \
                        "$temp_dir/node/share" \
                        "$install_prefix" ||
                        fail 'We could not finish installing Node.js. Please try again, or install it from https://nodejs.org.' "$?"
                else
                    if ! command -v sudo >/dev/null 2>&1; then
                        fail 'We could not install Node.js automatically. Please install it from https://nodejs.org, then run this command again.'
                    fi
                    # sudo reads passwords from /dev/tty even when this script is piped to sh.
                    sudo mkdir -p "$install_prefix" ||
                        fail 'We could not finish installing Node.js. Please try again, or install it from https://nodejs.org.' "$?"
                    sudo cp -R \
                        "$temp_dir/node/bin" \
                        "$temp_dir/node/include" \
                        "$temp_dir/node/lib" \
                        "$temp_dir/node/share" \
                        "$install_prefix" ||
                        fail 'We could not finish installing Node.js. Please try again, or install it from https://nodejs.org.' "$?"
                fi
            )

            # Clean up: remove successful downloads and clear the now-unneeded exit/signal traps.
            rm -rf "$temp_dir"
            trap - 0 INT TERM HUP
        fi
    fi

    # Validate: report an incomplete installation or unsupported version instead of replacing it.
    if ! command -v node >/dev/null 2>&1; then
        fail 'We could not finish installing Node.js. Please install it from https://nodejs.org, then run this command again.'
    fi
    if ! node -e '
        const [major, minor] = process.versions.node.split(".").map(Number);
        // Package engines require Node >=22.12.0: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander
        const supported = major > 22 || (major === 22 && minor >= 12);
        process.exit(supported ? 0 : 1);
    ' 2>/dev/null; then
        fail 'Your Node.js version is too old. Please install a newer version from https://nodejs.org, then run this command again.'
    fi
    if ! command -v npx >/dev/null 2>&1; then
        fail 'Your Node.js installation is incomplete. Please reinstall Node.js from https://nodejs.org, then run this command again.'
    fi

    # Start as the original user: --yes accepts npm's package-download prompt.
    printf '%s\n' 'Starting Remote Desktop Commander. To stop it, press Ctrl+C. To start it again, run this command again.'
    # -t 0 checks whether stdin is a terminal. A curl | sh pipe needs /dev/tty for interactive input.
    # The isolated ':' command checks that /dev/tty can be opened without consuming any input.
    # exec replaces this launcher process, preserving the device command's exit status and Ctrl+C behavior.
    if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
        exec npx --yes @wonderwhy-er/desktop-commander@latest remote </dev/tty
    fi
    exec npx --yes @wonderwhy-er/desktop-commander@latest remote
)
