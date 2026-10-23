@echo off
powershell.exe -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-RestMethod -ErrorAction Stop 'https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/scripts/remote/remote-windows.ps1' | Invoke-Expression"
exit /b %ERRORLEVEL%
