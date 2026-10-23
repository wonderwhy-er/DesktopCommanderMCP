# Remote device launchers

These scripts install Node.js when missing and run `npx --yes @wonderwhy-er/desktop-commander@latest remote` (`npx.cmd` on Windows). `--yes` accepts npm's package download prompt. Inspect the source before running: [macOS](remote-macos.sh), [Linux](remote-linux.sh), [PowerShell](remote-windows.ps1), [CMD wrapper](remote-windows.cmd).

For a fixed revision, replace `refs/heads/main` in the URLs below with its commit SHA.

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

Alternatively, save and run [remote-windows.cmd](remote-windows.cmd). Press **Ctrl+C** to stop; rerun the same command to reconnect. Installing Node.js may prompt for an administrator password or Windows approval. Only installation is elevated; Desktop Commander runs as the user who started the command. No shell-profile or execution-policy changes are needed.

Node.js 22.12+ is reused. Older Node.js or missing npm/npx produces an upgrade/repair message. When Node is absent, the launcher downloads the latest Node 24 from `nodejs.org` and verifies SHA-256 before installing:

- **macOS:** the official `.pkg` through `installer -target /`, placing Node.js and npm under `/usr/local`.
- **Windows:** the official `.msi` with its normal installation directory, usually `C:\Program Files\nodejs`.
- **Linux:** the official binary archive under `/usr/local`, Node.js's [default installation prefix](https://github.com/nodejs/node/blob/v24.x/configure.py#L76-L80). This installation is not managed by the distribution's package manager.

Subsequent runs reuse the installed runtime. The launcher makes it available to the current command; open a new terminal to pick up installer changes to PATH. Earlier private installations are not deleted.

Automatic installation supports Intel/Apple Silicon Macs and x64/ARM64 Windows and glibc Linux supported by Node 24. Other systems need compatible Node.js and npm installed first. Internet access is required; Unix also needs `curl`, `shasum` (macOS) or `tar` and `sha256sum` (Linux), plus `sudo` when installing as a non-root user.

Checks: `node test/remote-launchers.test.js` and `pwsh -NoProfile -File test/remote-launcher-windows.test.ps1` (use `powershell` on Windows). Downloads, privileged installation, and device commands are stubbed; fixtures do not modify the host's Node.js installation.
