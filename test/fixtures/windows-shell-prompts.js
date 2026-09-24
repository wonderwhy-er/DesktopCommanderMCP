/**
 * The end of stdout of real interactive Windows shells, captured from real
 * sessions on Windows 11 (10.0.26200), started the way start_process starts a
 * command (powershell.exe -Command <command>, piped stdio, windowsHide): at start,
 * after "echo hi" (the shells echo the input line), and at PowerShell's
 * continuation prompt after "if ($true) {". Nothing was written to stderr.
 * Only the working directory in the prompts was replaced, with a neutral
 * C:\Users\me\project; everything else (banners, CRLF, spaces) is as captured.
 * Each entry is [what, output ending in the prompt].
 */
export const WINDOWS_SHELL_PROMPTS = [
  ["powershell.exe (Windows PowerShell 5.1), at start", "Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\nPS C:\\Users\\me\\project> "],
  ["powershell.exe -NoLogo, at start", "PS C:\\Users\\me\\project> "],
  ["powershell.exe, after a command's output", "eserved.\r\n\r\nPS C:\\Users\\me\\project> echo hi\nhi\r\nPS C:\\Users\\me\\project> "],
  ["powershell.exe, continuation prompt", ":\\Users\\me\\project> echo hi\nhi\r\nPS C:\\Users\\me\\project> if ($true) {\n>> "],
  ["pwsh (PowerShell 7.6.6), at start", "PowerShell 7.6.6\r\nPS C:\\Users\\me\\project> "],
  ["pwsh, after a command's output", "hell 7.6.6\r\nPS C:\\Users\\me\\project> echo hi\nhi\r\nPS C:\\Users\\me\\project> "],
  ["pwsh, continuation prompt", ":\\Users\\me\\project> echo hi\nhi\r\nPS C:\\Users\\me\\project> if ($true) {\n>> "],
  ["cmd.exe, at start", "Microsoft Windows [Version 10.0.26200.9457]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\nC:\\Users\\me\\project>"],
  ["cmd.exe, after a command's output", "ghts reserved.\r\n\r\nC:\\Users\\me\\project>echo hi\nhi\r\n\r\nC:\\Users\\me\\project>"],
];
