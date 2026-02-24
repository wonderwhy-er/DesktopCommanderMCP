export const ROLE_ALIASES: Record<string, string[]> = {
  toggle: ['AXSwitch', 'AXCheckBox', 'AXToggle'],
  switch: ['AXSwitch', 'AXCheckBox', 'AXToggle'],
  button: ['AXButton', 'AXToolbarButton', 'AXMenuButton'],
  text: ['AXTextField', 'AXTextArea', 'AXSearchField'],
  input: ['AXTextField', 'AXTextArea', 'AXSearchField', 'AXSecureTextField'],
  menu: ['AXMenuItem', 'AXMenuBarItem'],
  link: ['AXLink', 'AXButton'],
  row: ['AXRow', 'AXCell'],
  list: ['AXList', 'AXOutline', 'AXTable'],
};

/**
 * Expands aliases like "toggle" or "axswitch" into concrete AX roles.
 */
export function expandRoleAlias(role?: string | null): string[] | undefined {
  if (!role) {
    return undefined;
  }

  const trimmed = role.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (ROLE_ALIASES[lower]) {
    return ROLE_ALIASES[lower];
  }

  if (lower.startsWith('ax')) {
    const withoutPrefix = lower.slice(2);
    if (ROLE_ALIASES[withoutPrefix]) {
      return ROLE_ALIASES[withoutPrefix];
    }
  }

  return [trimmed];
}
