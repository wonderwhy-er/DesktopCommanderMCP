/**
 * Shared shell behavior for collapsible sections and common UI affordances. It keeps repeated interaction patterns consistent across tool apps.
 */
const EXPAND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5z"></path></svg>';
const COLLAPSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 14l5-5 5 5z"></path></svg>';

export interface ToolShellController {
  getExpanded: () => boolean;
  setExpanded: (nextExpanded: boolean) => void;
  toggle: () => void;
  dispose: () => void;
}

interface CreateToolShellControllerOptions {
  shell: HTMLElement | null;
  toggleButton: HTMLButtonElement | null;
  initialExpanded: boolean;
  onToggle?: (expanded: boolean) => void;
  onScrollAfterExpand?: () => void;
  onRender?: () => void;
}

interface CreateCompactRowShellControllerOptions {
  shell: HTMLElement | null;
  compactRow: HTMLElement | null;
  initialExpanded: boolean;
  onToggle?: (expanded: boolean) => void;
  onScrollAfterExpand?: () => void;
  onRender?: () => void;
}

function syncExpandButton(toggleButton: HTMLButtonElement | null, expanded: boolean): void {
  if (!toggleButton) {
    return;
  }
  const label = expanded ? 'Collapse' : 'Expand';
  toggleButton.title = label;
  toggleButton.setAttribute('aria-label', label);
  toggleButton.innerHTML = expanded ? COLLAPSE_ICON : EXPAND_ICON;
}

function syncShellClasses(shell: HTMLElement | null, expanded: boolean): void {
  if (!shell) {
    return;
  }
  shell.classList.toggle('expanded', expanded);
  shell.classList.toggle('collapsed', !expanded);
}

export function createToolShellController(options: CreateToolShellControllerOptions): ToolShellController {
  const { shell, toggleButton, initialExpanded, onToggle, onScrollAfterExpand, onRender } = options;
  let isExpanded = initialExpanded;
  let scrollTrackedForCurrentExpand = false;
  const shouldTrackScroll = typeof onScrollAfterExpand === 'function';

  const applyExpandedState = (nextExpanded: boolean): void => {
    const wasExpanded = isExpanded;
    isExpanded = nextExpanded;
    syncShellClasses(shell, isExpanded);
    syncExpandButton(toggleButton, isExpanded);
    if (!wasExpanded && isExpanded) {
      scrollTrackedForCurrentExpand = false;
    }
  };

  const toggle = (): void => {
    applyExpandedState(!isExpanded);
    onToggle?.(isExpanded);
    onRender?.();
  };

  const handleScroll = (event?: Event): void => {
    if (!isExpanded || scrollTrackedForCurrentExpand) {
      return;
    }
    const targetNode = event?.target instanceof Node ? event.target : null;
    if (targetNode && shell && !shell.contains(targetNode)) {
      return;
    }
    scrollTrackedForCurrentExpand = true;
    onScrollAfterExpand?.();
  };

  applyExpandedState(isExpanded);
  toggleButton?.addEventListener('click', toggle);
  if (shouldTrackScroll) {
    shell?.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
  }

  return {
    getExpanded: () => isExpanded,
    setExpanded: applyExpandedState,
    toggle,
    dispose: () => {
      toggleButton?.removeEventListener('click', toggle);
      if (shouldTrackScroll) {
        shell?.removeEventListener('scroll', handleScroll);
        document.removeEventListener('scroll', handleScroll, true);
      }
    },
  };
}

export function createCompactRowShellController(options: CreateCompactRowShellControllerOptions): ToolShellController {
  const { shell, compactRow, initialExpanded, onToggle, onScrollAfterExpand, onRender } = options;

  const controller = createToolShellController({
    shell,
    toggleButton: null,
    initialExpanded,
    onToggle: (expanded) => {
      compactRow?.setAttribute('aria-expanded', String(expanded));
      onToggle?.(expanded);
    },
    onScrollAfterExpand,
    onRender,
  });

  compactRow?.setAttribute('aria-expanded', String(initialExpanded));

  const handleCompactClick = (): void => {
    controller.toggle();
  };

  const handleCompactKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    controller.toggle();
  };

  compactRow?.addEventListener('click', handleCompactClick);
  compactRow?.addEventListener('keydown', handleCompactKeydown);

  return {
    getExpanded: controller.getExpanded,
    setExpanded: controller.setExpanded,
    toggle: controller.toggle,
    dispose: () => {
      compactRow?.removeEventListener('click', handleCompactClick);
      compactRow?.removeEventListener('keydown', handleCompactKeydown);
      controller.dispose();
    },
  };
}
