# Remote device launchers

These scripts start Remote Desktop Commander on your computer. If Node.js cannot be found, they explain what will be installed and ask you to type **Yes** or **No**. Yes installs Node.js 24, then downloads and starts Remote Desktop Commander. No, an empty answer, or an unrecognized answer stops without installing or starting anything. It shows two options: first, download Node.js using a direct link for your computer; second, run the command yourself in a new terminal if Node.js is already installed. If compatible Node.js is found, setup starts Remote Desktop Commander without asking again.

The manual links point directly to Node.js v24.22.1 files, so showing them needs no internet connection. macOS gets a universal installer; Windows and supported Linux computers get the matching processor version. Opening a link downloads the file. macOS and Windows users can open it to install Node.js; Linux users must install the downloaded archive themselves. Unsupported processors receive a link to [the Node.js download page](https://nodejs.org/en/download) instead of an incompatible file. Keep these pinned links in sync with the onboarding page's manual downloads.

Inspect the source: [macOS](remote-macos.sh), [Linux](remote-linux.sh), [PowerShell](remote-windows.ps1), [CMD wrapper](remote-windows.cmd).

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

Alternatively, save and run [remote-windows.cmd](remote-windows.cmd). Press **Ctrl+C** to stop; run the same command again to reconnect. Your computer may ask you to confirm during installation. Open a terminal window to answer the setup question; setup will not install Node.js if it cannot read your answer.

Node.js 22.12+ is reused. Messages asking users to upgrade, reinstall or manually install Node.js include the same manual download link. Unknown processors and Linux systems that cannot run the downloaded binary receive the Node.js download page instead. When Node is absent and you choose Yes, the launcher downloads the latest Node 24 from `nodejs.org` and verifies SHA-256 before installing:

- **macOS:** the official `.pkg` through `installer -target /`, placing Node.js and npm under `/usr/local`.
- **Windows:** the official `.msi` with its normal installation directory, usually `C:\Program Files\nodejs`.
- **Linux:** the official binary archive under `/usr/local`, Node.js's [default installation prefix](https://github.com/nodejs/node/blob/v24.x/configure.py#L76-L80). This installation is not managed by the distribution's package manager.

The launcher then runs `npx --yes @wonderwhy-er/desktop-commander@latest remote` (`npx.cmd` on Windows). This downloads the package into npm's cache and starts it; `--yes` accepts npm's package download prompt. Only Node installation is elevated; Desktop Commander runs as the user who started the command. No shell-profile or execution-policy changes are needed.

Subsequent runs reuse the installed runtime. The launcher makes it available to the current command; open a new terminal to pick up installer changes to PATH. Earlier private installations are not deleted.

Automatic installation supports Intel/Apple Silicon Macs and x64/ARM64 Windows and glibc Linux supported by Node 24. Other systems need compatible Node.js and npm installed first. Internet access is required; Unix also needs `curl`, `shasum` (macOS) or `tar` and `sha256sum` (Linux), plus `sudo` when installing as a non-root user.

Checks: `node test/remote-launchers.test.js` and `pwsh -NoProfile -File test/remote-launcher-windows.test.ps1` (use `powershell` on Windows). Downloads, privileged installation, and device commands are stubbed; fixtures do not modify the host's Node.js installation.
