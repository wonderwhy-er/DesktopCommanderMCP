/** Model-visible tools are compared with the distribution manifest. */
export function isModelVisibleTool(tool) {
  const visibility = tool?._meta?.ui?.visibility;
  // Omitting visibility exposes the tool to both model and app by default.
  return !Array.isArray(visibility) || visibility.includes('model');
}
