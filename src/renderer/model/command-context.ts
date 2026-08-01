import type { FinderWindowState, MacintoshState, VfsNode } from '../../shared/state';
import { descendantsOf } from '../../shared/vfs';

export interface MenuShortcut {
  key: string;
  command: boolean;
  shift: boolean;
  control: boolean;
  option: boolean;
}

type MenuShortcutModifiers = Partial<Omit<MenuShortcut, 'key' | 'command'>>;

export const commandShortcut = (
  key: string,
  modifiers: MenuShortcutModifiers = {},
): MenuShortcut => ({
  key: key.toLowerCase(),
  command: true,
  shift: modifiers.shift ?? false,
  control: modifiers.control ?? false,
  option: modifiers.option ?? false,
});

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

export const menuShortcutLabel = (shortcut: MenuShortcut): string =>
  `${shortcut.control ? '⌃' : ''}${shortcut.option ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.command ? '⌘' : ''}${shortcut.key.toUpperCase()}`;

export const findMenuShortcutEntry = <TMenu extends ShortcutMenu>(
  menus: readonly TMenu[],
  event: ShortcutEvent,
): TMenu['entries'][number] | null => {
  const key = event.key.toLowerCase();
  for (const menu of menus) {
    const entry = menu.entries.find(
      (candidate) =>
        !candidate.disabled &&
        !candidate.separator &&
        candidate.shortcut?.key === key &&
        candidate.shortcut.command === event.metaKey &&
        candidate.shortcut.control === event.ctrlKey &&
        candidate.shortcut.option === event.altKey &&
        candidate.shortcut.shift === event.shiftKey,
    );
    if (entry) return entry as TMenu['entries'][number];
  }
  return null;
};

export const hasOpenDocumentInTrash = (
  nodes: VfsNode[],
  openDocumentIds: Iterable<string>,
): boolean => {
  const trashDescendants = descendantsOf(nodes, 'trash');
  for (const documentId of openDocumentIds) {
    const node = nodes.find((candidate) => candidate.id === documentId);
    if (node?.kind === 'document' && trashDescendants.has(documentId)) return true;
  }
  return false;
};

export interface FinderCommandContext {
  activeWindow: FinderWindowState | null;
  activeNode: VfsNode | null;
  visibleSelection: VfsNode[];
  visibleSelectionIds: string[];
}

export const finderCommandDestinationId = (
  state: MacintoshState,
  activeWindowId: string | null,
): string => {
  const activeWindow = state.desktop.windows.find((window) => window.id === activeWindowId);
  const activeNode = activeWindow
    ? state.nodes.find((node) => node.id === activeWindow.nodeId)
    : undefined;
  return activeNode?.kind === 'disk' || activeNode?.kind === 'folder' ? activeNode.id : 'desktop';
};

export const deriveFinderCommandContext = (
  state: MacintoshState | null,
  selectedIds: ReadonlySet<string>,
  activeWindowId: string | null,
): FinderCommandContext => {
  const activeWindow =
    state?.desktop.windows.find((window) => window.id === activeWindowId) ?? null;
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
