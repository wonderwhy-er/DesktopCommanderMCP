# Remote device launchers

These scripts install Node.js when missing and run `npx --yes @wonderwhy-er/desktop-commander@latest remote` (`npx.cmd` on Windows). `--yes` accepts npm's package download prompt. Inspect the source before running: [macOS](remote-macos.sh), [Linux](remote-linux.sh), [PowerShell](remote-windows.ps1), [CMD wrapper](remote-windows.cmd).

The `main` URLs below, including the CMD wrapper's download, become available after this change is merged. For a fixed revision, replace `refs/heads/main` with its commit SHA.

macOS, including zsh, bash, and fish:

```sh
curl -fsSL https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/scripts/remote/remote-macos.sh | sh
```

Linux, using POSIX `sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/scripts/remote/remote-linux.sh | sh
```

Windows PowerShell 5.1 or newer, or Command Prompt (enables TLS 1.2 in a child PowerShell before downloading):

```powershell
powershell.exe -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-RestMethod -ErrorAction Stop 'https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/scripts/remote/remote-windows.ps1' | Invoke-Expression"
```

Alternatively, save and run [remote-windows.cmd](remote-windows.cmd). Press **Ctrl+C** to stop; rerun the same command to reconnect. No administrator access, shell-profile changes, or execution-policy changes are needed for the one-liners.

Node.js 22.12+ is reused. Older Node.js or missing npm/npx produces an upgrade/repair message. When Node is absent, the launcher downloads the latest Node 24 from `nodejs.org`, verifies SHA-256, and saves it under `~/.local/share/desktop-commander/node` or `%LOCALAPPDATA%\DesktopCommander\node`. Subsequent runs reuse it; PATH changes last only while the launcher runs.

Automatic installation supports Intel/Apple Silicon Macs and x64/ARM64 Windows and glibc Linux supported by Node 24. Other systems need compatible Node.js and npm installed first. Internet access is required; Unix also needs `curl`, `tar`, and `shasum` (macOS) or `sha256sum` (Linux).

Checks: `node test/remote-launchers.test.js` and `pwsh -NoProfile -File test/remote-launcher-windows.test.ps1` (use `powershell` on Windows). Downloads and device commands are stubbed; the PowerShell test also stubs ZIP extraction.
