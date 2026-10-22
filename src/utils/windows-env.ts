/**
 * Restore ProgramData for Windows child processes started with a filtered MCP
 * environment. Windows OpenSSH can exit 255 without output when this standard
 * variable is missing (see Desktop Commander #627 and #702).
 *
 * Repair only the child's environment; never change process.env or the registry.
 * Keep any inherited (including non-standard) ProgramData path intact.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(key =>
    key.toLowerCase() === name.toLowerCase() && !!env[key]
  );
  return key === undefined ? undefined : env[key];
}

export function repairWindowsProgramData(
  childEnv: NodeJS.ProcessEnv,
  parentEnv: NodeJS.ProcessEnv = process.env
): void {
  if (envValue(childEnv, 'ProgramData')) return;

  const fromParent = envValue(parentEnv, 'ProgramData');
  const drive = envValue(parentEnv, 'SystemDrive') ??
    envValue(parentEnv, 'SystemRoot')?.match(/^[A-Za-z]:/)?.[0];

  // Do not guess C: when Windows is installed on an unknown drive.
  const replacement = fromParent ||
    (drive && /^[A-Za-z]:$/.test(drive) ? `${drive}\\ProgramData` : undefined);
  if (!replacement) return;

  // Windows environment keys are case-insensitive. Do not pass both spellings
  // if an upstream launcher supplied an empty PROGRAMDATA entry.
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === 'programdata') delete childEnv[key];
  }
  childEnv.ProgramData = replacement;
}
