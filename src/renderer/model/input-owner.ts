export type KeyboardOwner =
  | 'persistence-alert'
  | 'normal-quit'
  | 'dialog'
  | 'ejection'
  | 'pointer-session'
  | 'menu'
  | 'write'
  | 'calculator'
  | 'finder'
  | 'desktop';

export type ActiveApplication =
  { type: 'finder'; windowId: string | null } | { type: 'write'; windowId: string };

export type ActiveTarget =
  | { type: 'desktop' }
  | { type: 'finder-window'; id: string }
  | { type: 'write-window'; id: string }
  | { type: 'calculator' };

export type OrdinaryWindowId = `finder:${string}` | `write:${string}` | 'calculator';

export const finderOrdinaryWindowId = (windowId: string): OrdinaryWindowId => `finder:${windowId}`;

export const writeOrdinaryWindowId = (windowId: string): OrdinaryWindowId => `write:${windowId}`;

export const ordinaryWindowIdForTarget = (target: ActiveTarget): OrdinaryWindowId | null => {
  switch (target.type) {
    case 'finder-window':
      return finderOrdinaryWindowId(target.id);
    case 'write-window':
      return writeOrdinaryWindowId(target.id);
    case 'calculator':
      return 'calculator';
    case 'desktop':
      return null;
  }
};

export const raiseOrdinaryWindow = (
  order: OrdinaryWindowId[],
  target: ActiveTarget,
): OrdinaryWindowId[] => {
  const windowId = ordinaryWindowIdForTarget(target);
  if (!windowId || order.at(-1) === windowId) return order;
  return [...order.filter((candidate) => candidate !== windowId), windowId];
};

export const reconcileOrdinaryWindowOrder = (
  order: OrdinaryWindowId[],
  validWindowIds: readonly OrdinaryWindowId[],
): OrdinaryWindowId[] => {
  const valid = new Set(validWindowIds);
  const seen = new Set<OrdinaryWindowId>();
  const next = order.filter((windowId) => {
    if (!valid.has(windowId) || seen.has(windowId)) return false;
    seen.add(windowId);
    return true;
  });
  for (const windowId of validWindowIds) {
    if (seen.has(windowId)) continue;
    seen.add(windowId);
    next.push(windowId);
  }
  return next.length === order.length && next.every((windowId, index) => order[index] === windowId)
    ? order
    : next;
};

export interface KeyboardContext {
  persistenceAlertOpen: boolean;
  normalQuitInProgress: boolean;
  dialogOpen: boolean;
  ejectionInProgress: boolean;
  pointerSessionActive: boolean;
  menuOpen: boolean;
  activeTarget: ActiveTarget;
}

export const activeApplicationAfterTarget = (
  current: ActiveApplication,
  target: ActiveTarget,
): ActiveApplication => {
  switch (target.type) {
    case 'desktop':
      return { type: 'finder', windowId: null };
    case 'finder-window':
      return { type: 'finder', windowId: target.id };
    case 'write-window':
      return { type: 'write', windowId: target.id };
    case 'calculator':
      return current;
  }
};

export const resolveKeyboardOwner = (context: KeyboardContext): KeyboardOwner => {
  if (context.persistenceAlertOpen) return 'persistence-alert';
  if (context.normalQuitInProgress) return 'normal-quit';
  if (context.dialogOpen) return 'dialog';
  if (context.ejectionInProgress) return 'ejection';
  if (context.pointerSessionActive) return 'pointer-session';
  if (context.menuOpen) return 'menu';
  switch (context.activeTarget.type) {
    case 'write-window':
      return 'write';
    case 'calculator':
      return 'calculator';
    case 'finder-window':
      return 'finder';
    case 'desktop':
      return 'desktop';
  }
};
