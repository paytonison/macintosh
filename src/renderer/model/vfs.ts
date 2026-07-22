import type { FinderViewMode, MacintoshState, VfsNode } from '../../shared/state';

export interface Rectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const rectanglesOverlap = (first: Rectangle, second: Rectangle): boolean =>
  first.left < second.right &&
  first.right > second.left &&
  first.top < second.bottom &&
  first.bottom > second.top;

export const listChildren = (
  nodes: VfsNode[],
  parentId: string,
  viewMode: FinderViewMode,
): VfsNode[] => {
  const children = nodes.filter((node) => node.parentId === parentId);
  if (viewMode === 'list') {
    return [...children].sort((left, right) => left.name.localeCompare(right.name));
  }
  return children;
};

export const descendantsOf = (nodes: VfsNode[], parentId: string): Set<string> => {
  const descendants = new Set<string>();
  const queue = [parentId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const node of nodes) {
      if (node.parentId === current && !descendants.has(node.id)) {
        descendants.add(node.id);
        queue.push(node.id);
      }
    }
  }
  return descendants;
};

export const emptyTrash = (state: MacintoshState): MacintoshState => {
  const removed = descendantsOf(state.nodes, 'trash');
  return {
    ...state,
    nodes: state.nodes.filter((node) => !removed.has(node.id)),
    desktop: {
      ...state.desktop,
      windows: state.desktop.windows.filter((item) => !removed.has(item.nodeId)),
    },
  };
};

export const addFolder = (
  state: MacintoshState,
  parentId: string,
  timestamp = new Date().toISOString(),
): MacintoshState => {
  const siblings = state.nodes.filter((node) => node.parentId === parentId);
  const names = new Set(siblings.map((node) => node.name));
  let name = 'untitled folder';
  let suffix = 2;
  while (names.has(name)) {
    name = `untitled folder ${suffix}`;
    suffix += 1;
  }
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    ...state,
    nodes: [
      ...state.nodes,
      {
        id: `folder-${nonce}`,
        parentId,
        name,
        kind: 'folder',
        createdAt: timestamp,
        modifiedAt: timestamp,
      },
    ],
  };
};
