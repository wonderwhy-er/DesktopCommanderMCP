export type RuntimeEnvironment = NodeJS.ProcessEnv;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

export function getDefaultShell(
  platform: NodeJS.Platform = process.platform,
  env: RuntimeEnvironment = process.env,
): string {
  if (platform === 'win32') {
    return 'powershell.exe';
  }

  if (env.SHELL?.trim()) {
    return env.SHELL;
  }

  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

export function hasGraphicalSession(
  platform: NodeJS.Platform = process.platform,
  env: RuntimeEnvironment = process.env,
): boolean {
  if (platform === 'win32' || platform === 'darwin') {
    return true;
  }

  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET);
}

export function isHeadlessEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: RuntimeEnvironment = process.env,
): boolean {
  const configured = parseBoolean(env.DESKTOP_COMMANDER_HEADLESS);
  if (configured !== undefined) {
    return configured;
  }

  return platform === 'linux' && !hasGraphicalSession(platform, env);
}

export function getRuntimeLabel(
  platform: NodeJS.Platform = process.platform,
  env: RuntimeEnvironment = process.env,
): 'desktop' | 'headless' {
  return isHeadlessEnvironment(platform, env) ? 'headless' : 'desktop';
}
