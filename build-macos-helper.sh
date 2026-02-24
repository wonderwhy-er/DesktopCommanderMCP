#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_DIR="$ROOT_DIR/native/macos-ax-helper"
OUT_DIR="$ROOT_DIR/bin/macos"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos-helper.sh is macOS-only"
  exit 1
fi

mkdir -p "$OUT_DIR"

build_arch() {
  local arch="$1"
  local out_name="$2"

  echo "Building macos-ax-helper for $arch..."
  if swift build --package-path "$HELPER_DIR" -c release --arch "$arch"; then
    local built="$HELPER_DIR/.build/apple/Products/Release/macos-ax-helper"

    if [[ ! -f "$built" ]]; then
      built="$HELPER_DIR/.build/release/macos-ax-helper"
    fi

    if [[ ! -f "$built" ]]; then
      echo "Could not find built helper for $arch"
      return 1
    fi

    cp "$built" "$OUT_DIR/$out_name"
    chmod +x "$OUT_DIR/$out_name"
    echo "Wrote $OUT_DIR/$out_name"
  else
    echo "Warning: build failed for $arch"
    return 1
  fi
}

status=0
build_arch arm64 macos-ax-helper-darwin-arm64 || status=1
build_arch x86_64 macos-ax-helper-darwin-x64 || status=1

if [[ $status -ne 0 ]]; then
  echo "One or more architectures failed. If running on Apple Silicon, x64 build may require extra toolchains."
fi

exit $status
