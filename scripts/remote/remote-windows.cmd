@echo off

REM Prepare: use a child PowerShell so its TLS setting does not affect this CMD session.
REM Download: enable TLS 1.2 before fetching the public PowerShell launcher.
REM Start: the PowerShell launcher checks Node.js, installs it if missing, and runs remote.
REM Keep the PowerShell payload on one line to preserve CMD quoting and pipe handling.
powershell.exe -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-RestMethod -ErrorAction Stop 'https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/scripts/remote/remote-windows.ps1' | Invoke-Expression"

REM Return PowerShell's exit status without closing the caller's CMD session.
exit /b %ERRORLEVEL%
