@echo off

REM Download and run the public launcher in a child PowerShell using its TLS defaults.
REM The launcher checks Node.js, asks once before installing it if missing, and starts Remote Desktop Commander.
REM The PowerShell launcher adds support details to its errors; do not repeat them here.
REM Keep the PowerShell payload on one line to preserve CMD quoting and pipe handling.
powershell.exe -NoProfile -Command "irm -ErrorAction Stop https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/scripts/remote/remote-windows.ps1 | iex"

REM Return PowerShell's exit status without closing the caller's CMD session.
exit /b %ERRORLEVEL%
