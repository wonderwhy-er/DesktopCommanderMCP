# Cross-Platform Ripgrep Support for MCPB Bundles

## Problem

When building MCPB bundles on macOS, only the macOS ripgrep binary was included in `node_modules/@vscode/ripgrep/bin/`. This caused failures on Windows with the error:

```
spawn C:\Users\...\AppData\Roaming\Claude\Claude Extensions\...\node_modules\@vscode\ripgrep\bin\rg.exe ENOENT
```

The `@vscode/ripgrep` package downloads platform-specific binaries during `npm install` via a postinstall script. This meant bundles built on Mac only worked on Mac, bundles built on Windows only worked on Windows, etc.

## Solution

We now download **all** platform-specific ripgrep binaries during the MCPB build process and include them in the bundle with a runtime wrapper that selects the correct binary based on the platform.

### Components

1. **`scripts/download-all-ripgrep.cjs`**
   - Downloads ripgrep binaries for all supported platforms
   - Extracts them to `node_modules/@vscode/ripgrep/bin/` with platform-specific names
   - Platforms supported:
     - macOS: x86_64, ARM64
     - Windows: x86_64, ARM64, i686
     - Linux: x86_64 (musl), ARM64 (musl), i686 (musl), ARM (gnueabihf), PPC64LE, S390X

2. **`scripts/ripgrep-wrapper.js`**
   - Runtime platform detection wrapper
   - Replaces the original `@vscode/ripgrep/lib/index.js`
   - Selects the correct binary based on `os.platform()` and `os.arch()`
   - Exports `rgPath` pointing to the platform-specific binary

3. **Updated `scripts/build-mcpb.cjs`**
   - Step 0: Downloads all ripgrep binaries
   - Step 6c: Copies binaries and installs wrapper in bundle

### Binary Naming Convention

Binaries are named using the Rust target triple format:
- `rg-x86_64-apple-darwin` (macOS Intel)
- `rg-aarch64-apple-darwin` (macOS Apple Silicon)
- `rg-x86_64-pc-windows-msvc.exe` (Windows 64-bit)
- `rg-aarch64-pc-windows-msvc.exe` (Windows ARM64)
- `rg-x86_64-unknown-linux-musl` (Linux 64-bit)
- etc.

## Usage

### Building the MCPB Bundle

```bash
npm run build:mcpb
```

This will:
1. Download all ripgrep binaries (cached in `.ripgrep-downloads/`)
2. Build TypeScript
3. Create bundle with all binaries
4. Install platform detection wrapper
5. Pack into `.mcpb` file

### Bundle Size

The cross-platform bundle is larger (~23.7MB vs ~4.8MB) because it includes 11 ripgrep binaries instead of 1. However, this ensures the bundle works on **all** platforms without requiring platform-specific builds.

## Testing

To test on Windows without a Windows machine:
1. Build the `.mcpb` bundle on macOS
2. Transfer to Windows machine
3. Install in Claude Desktop
4. The wrapper will automatically select `rg-x86_64-pc-windows-msvc.exe`

## Cache

Downloaded binaries are cached in `.ripgrep-downloads/` (git-ignored). Delete this directory to force re-download:

```bash
rm -rf .ripgrep-downloads
```

## Future Improvements

- [ ] Consider downloading binaries on-demand at install time (smaller bundle)
- [ ] Add checksum verification for downloaded binaries
- [ ] Support for custom ripgrep versions via environment variable
