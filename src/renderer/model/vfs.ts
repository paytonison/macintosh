import type { ImportedEntry } from '../../shared/contracts';
import type { FinderViewMode, MacintoshState, Point, VfsNode } from '../../shared/state';

const MAX_VFS_NODES = 512;
const MAX_VFS_CONTENT = 192 * 1024;

export interface VfsMutationResult {
  state: MacintoshState;
  affectedIds: string[];
  skippedCount: number;
  truncatedCount: number;
}

export interface Rectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NodeIconPlacement {
  nodeId: string;
  position: Point;
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

const isContainer = (node: VfsNode | undefined): boolean =>
  node?.kind === 'desktop' ||
  node?.kind === 'disk' ||
  node?.kind === 'folder' ||
  node?.kind === 'trash';

const cleanName = (value: string): string =>
  value.replaceAll('\0', '').replaceAll('/', ':').trim().slice(0, 96) || 'untitled';

const splitExtension = (name: string, kind: VfsNode['kind']): [string, string] => {
  if (kind !== 'document') return [name, ''];
  const index = name.lastIndexOf('.');
  return index > 0 ? [name.slice(0, index), name.slice(index)] : [name, ''];
};

const uniqueName = (requested: string, kind: VfsNode['kind'], names: Set<string>): string => {
  const name = cleanName(requested);
  const folded = new Set([...names].map((item) => item.toLocaleLowerCase()));
  if (!folded.has(name.toLocaleLowerCase())) return name;
  const [stem, extension] = splitExtension(name, kind);
  const shortExtension = extension.slice(0, 24);
  let suffix = ' copy';
  let number = 2;
  const candidate = (): string =>
    `${stem.slice(0, Math.max(1, 96 - suffix.length - shortExtension.length))}${suffix}${shortExtension}`;
  while (folded.has(candidate().toLocaleLowerCase())) {
    suffix = ` copy ${number}`;
    number += 1;
  }
  return candidate();
};

const uniqueId = (prefix: string, ids: Set<string>): string => {
  let id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  while (ids.has(id)) {
    id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }
  ids.add(id);
  return id;
};

const topLevelSelection = (nodes: VfsNode[], ids: Iterable<string>): VfsNode[] => {
  const selected = new Set(ids);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    if (
      !selected.has(node.id) ||
      node.id === 'desktop' ||
      node.id === 'system-disk' ||
      node.id === 'trash'
    ) {
      return false;
    }
    let parentId = node.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
};

const contentSize = (nodes: VfsNode[]): number =>
  nodes.reduce((total, node) => total + (node.content?.length ?? 0), 0);

const validTimestamp = (value: string, fallback: string): string =>
  value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : fallback;

const importedTreeSize = (entry: ImportedEntry): number =>
  1 + (entry.children ?? []).reduce((total, child) => total + importedTreeSize(child), 0);

export const moveNodes = (
  state: MacintoshState,
  nodeIds: Iterable<string>,
  parentId: string,
  timestamp = new Date().toISOString(),
): VfsMutationResult => {
  const parent = state.nodes.find((node) => node.id === parentId);
  if (!isContainer(parent)) {
    return { state, affectedIds: [], skippedCount: 0, truncatedCount: 0 };
  }

  const selected = topLevelSelection(state.nodes, nodeIds);
  const movable = selected.filter(
    (node) => node.id !== parentId && !descendantsOf(state.nodes, node.id).has(parentId),
  );
  const names = new Set(
    state.nodes.filter((node) => node.parentId === parentId).map((node) => node.name),
  );
  const updates = new Map<string, { name: string; parentId: string }>();

  for (const node of movable) {
    if (node.parentId === parentId) continue;
    const name = uniqueName(node.name, node.kind, names);
    names.add(name);
    updates.set(node.id, { name, parentId });
  }

  if (updates.size === 0) {
    return {
      state,
      affectedIds: [],
      skippedCount: selected.length - movable.length,
      truncatedCount: 0,
    };
  }
  return {
    state: {
      ...state,
      nodes: state.nodes.map((node) => {
        const update = updates.get(node.id);
        return update
          ? { ...node, ...update, iconPosition: undefined, modifiedAt: timestamp }
          : node;
      }),
    },
    affectedIds: [...updates.keys()],
    skippedCount: selected.length - movable.length,
    truncatedCount: 0,
  };
};

export const duplicateNodes = (
  state: MacintoshState,
  nodeIds: Iterable<string>,
  parentId: string,
  timestamp = new Date().toISOString(),
): VfsMutationResult => {
  const parent = state.nodes.find((node) => node.id === parentId);
  if (!isContainer(parent)) {
    return { state, affectedIds: [], skippedCount: 0, truncatedCount: 0 };
  }

  const roots = topLevelSelection(state.nodes, nodeIds);
  const byParent = new Map<string, VfsNode[]>();
  for (const node of state.nodes) {
    if (!node.parentId) continue;
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  const ids = new Set(state.nodes.map((node) => node.id));
  const names = new Set(
    state.nodes.filter((node) => node.parentId === parentId).map((node) => node.name),
  );
  const additions: VfsNode[] = [];
  const affectedIds: string[] = [];
  let remainingContent = Math.max(0, MAX_VFS_CONTENT - contentSize(state.nodes));
  let skippedCount = 0;
  let truncatedCount = 0;

  const clone = (
    source: VfsNode,
    destinationId: string,
    name: string,
    retainIconPosition: boolean,
  ): VfsNode | null => {
    if (state.nodes.length + additions.length >= MAX_VFS_NODES) {
      skippedCount += 1 + descendantsOf(state.nodes, source.id).size;
      return null;
    }
    const id = uniqueId(source.kind === 'folder' ? 'folder' : 'document', ids);
    let content = source.content;
    if (content && content.length > remainingContent) {
      content = content.slice(0, remainingContent);
      remainingContent = 0;
      truncatedCount += 1;
    } else {
      remainingContent -= content?.length ?? 0;
    }
    const copy: VfsNode = {
      ...source,
      id,
      parentId: destinationId,
      name,
      iconPosition: retainIconPosition ? source.iconPosition : undefined,
      ...(content === undefined ? {} : { content }),
      createdAt: timestamp,
      modifiedAt: timestamp,
    };
    additions.push(copy);
    for (const child of byParent.get(source.id) ?? []) {
      clone(child, id, child.name, true);
    }
    return copy;
  };

  for (const root of roots) {
    const name = uniqueName(root.name, root.kind, names);
    const copy = clone(root, parentId, name, false);
    if (copy) {
      names.add(name);
      affectedIds.push(copy.id);
    }
  }

  return {
    state: additions.length > 0 ? { ...state, nodes: [...state.nodes, ...additions] } : state,
    affectedIds,
    skippedCount,
    truncatedCount,
  };
};

export const mergeImportedEntries = (
  state: MacintoshState,
  entries: ImportedEntry[],
  parentId: string,
): VfsMutationResult => {
  const parent = state.nodes.find((node) => node.id === parentId);
  if (!isContainer(parent)) {
    return { state, affectedIds: [], skippedCount: entries.length, truncatedCount: 0 };
  }

  const ids = new Set(state.nodes.map((node) => node.id));
  const additions: VfsNode[] = [];
  const affectedIds: string[] = [];
  let remainingContent = Math.max(0, MAX_VFS_CONTENT - contentSize(state.nodes));
  let skippedCount = 0;
  let truncatedCount = 0;

  const addEntry = (
    entry: ImportedEntry,
    destinationId: string,
    siblingNames: Set<string>,
  ): VfsNode | null => {
    if (state.nodes.length + additions.length >= MAX_VFS_NODES) {
      skippedCount += importedTreeSize(entry);
      return null;
    }
    const kind = entry.kind === 'folder' ? 'folder' : 'document';
    const name = uniqueName(entry.name, kind, siblingNames);
    siblingNames.add(name);
    const now = new Date().toISOString();
    let content = kind === 'document' ? (entry.content ?? '') : undefined;
    if (content && content.length > remainingContent) {
      content = content.slice(0, remainingContent);
      remainingContent = 0;
      truncatedCount += 1;
    } else {
      remainingContent -= content?.length ?? 0;
    }
    const node: VfsNode = {
      id: uniqueId(kind, ids),
      parentId: destinationId,
      name,
      kind,
      ...(content === undefined ? {} : { content }),
      createdAt: validTimestamp(entry.createdAt, now),
      modifiedAt: validTimestamp(entry.modifiedAt, now),
    };
    additions.push(node);
    if (kind === 'folder') {
      const childNames = new Set<string>();
      for (const child of entry.children ?? []) addEntry(child, node.id, childNames);
    }
    return node;
  };

  const names = new Set(
    state.nodes.filter((node) => node.parentId === parentId).map((node) => node.name),
  );
  for (const entry of entries) {
    const node = addEntry(entry, parentId, names);
    if (node) affectedIds.push(node.id);
  }

  return {
    state: additions.length > 0 ? { ...state, nodes: [...state.nodes, ...additions] } : state,
    affectedIds,
    skippedCount,
    truncatedCount,
  };
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
  if (!isContainer(state.nodes.find((node) => node.id === parentId))) return state;
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

export const placeFinderIcons = (
  state: MacintoshState,
  parentId: string,
  placements: readonly NodeIconPlacement[],
): MacintoshState => {
  const byId = new Map(
    placements.flatMap(({ nodeId, position }) =>
      Number.isFinite(position.x) && Number.isFinite(position.y)
        ? [
            [
              nodeId,
              {
                x: Math.round(Math.min(8192, Math.max(0, position.x))),
                y: Math.round(Math.min(8192, Math.max(0, position.y))),
              },
            ] as const,
          ]
        : [],
    ),
  );
  if (byId.size === 0) return state;

  let changed = false;
  const nodes = state.nodes.map((node) => {
    const position = node.parentId === parentId ? byId.get(node.id) : undefined;
    if (!position || (node.iconPosition?.x === position.x && node.iconPosition.y === position.y)) {
      return node;
    }
    changed = true;
    return { ...node, iconPosition: position };
  });

  return changed ? { ...state, nodes } : state;
};
