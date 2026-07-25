import type { FinderWindowState, MacintoshState, VfsNode } from '../../shared/state';

export type MenuShortcut = 'a' | 'c' | 'i' | 'n' | 'o' | 'v' | 'w';

interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ShortcutEntry {
  shortcut?: MenuShortcut;
  disabled?: boolean;
  separator?: boolean;
}

interface ShortcutMenu {
  entries: readonly ShortcutEntry[];
}

export const menuShortcutLabel = (shortcut: MenuShortcut): string => `⌘${shortcut.toUpperCase()}`;

export const findMenuShortcutEntry = <TMenu extends ShortcutMenu>(
  menus: readonly TMenu[],
  event: ShortcutEvent,
): TMenu['entries'][number] | null => {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  for (const menu of menus) {
    const entry = menu.entries.find(
      (candidate) => !candidate.disabled && !candidate.separator && candidate.shortcut === key,
    );
    if (entry) return entry as TMenu['entries'][number];
  }
  return null;
};

export interface FinderCommandContext {
  activeWindow: FinderWindowState | null;
  activeNode: VfsNode | null;
  visibleSelection: VfsNode[];
  visibleSelectionIds: string[];
}

export const deriveFinderCommandContext = (
  state: MacintoshState | null,
  selectedIds: ReadonlySet<string>,
): FinderCommandContext => {
  const activeWindow = state?.desktop.windows.at(-1) ?? null;
  const activeNode = activeWindow
    ? (state?.nodes.find((node) => node.id === activeWindow.nodeId) ?? null)
    : null;
  if (!state || !activeNode) {
    return { activeWindow, activeNode, visibleSelection: [], visibleSelectionIds: [] };
  }

  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const visibleSelection = [...selectedIds].flatMap((id) => {
    const node = nodesById.get(id);
    return node?.parentId === activeNode.id ? [node] : [];
  });

  return {
    activeWindow,
    activeNode,
    visibleSelection,
    visibleSelectionIds: visibleSelection.map((node) => node.id),
  };
};
