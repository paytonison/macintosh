import type { ImportedEntry } from './contracts';
import {
  MAX_VFS_NODES,
  type FinderViewMode,
  type MacintoshState,
  type Point,
  type VfsNode,
} from './state';
import {
  documentPayloadEqual,
  documentPayloadText,
  MAX_DOCUMENT_TEXT,
  MAX_WRITE_BLOCKS,
  MAX_WRITE_INLINES,
  sanitizeDocumentPayload,
  WRITE_ALIGNMENTS,
  WRITE_FONT_FAMILIES,
  WRITE_FONT_SIZES,
  WRITE_LINE_SPACINGS,
  WRITE_MARK_TYPES,
  WRITE_PAGE_PRESET,
  type DocumentPayload,
} from './write';

export { MAX_VFS_NODES };
export const MAX_VFS_CONTENT = 192 * 1024;

const MAX_DOCUMENT_CONTENT = MAX_DOCUMENT_TEXT;
const MAX_IMPORTED_ROOTS = 64;
const MAX_IMPORTED_ENTRIES = 256;
const MAX_IMPORTED_DEPTH = 24;
const DESKTOP_ICON_WIDTH = 82;
const DESKTOP_ICON_HEIGHT = 78;
const DESKTOP_CASCADE_OFFSET: Point = { x: 13, y: 11 };

export interface VfsMutationResult {
  state: MacintoshState;
  affectedIds: string[];
  addedCount: number;
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

export interface DesktopSurfaceSize {
  width: number;
  height: number;
}

export interface DesktopPlacement {
  point: Point;
  surfaceSize: DesktopSurfaceSize;
}

interface DesktopPlacementCommand {
  desktopPlacement?: DesktopPlacement;
}

export interface CreateFolderCommand extends DesktopPlacementCommand {
  type: 'create-folder';
  parentId: string;
}

export interface CreateDocumentCommand extends DesktopPlacementCommand {
  type: 'create-document';
  parentId: string;
  name: string;
  payload: DocumentPayload;
}

export interface UpdateDocumentCommand {
  type: 'update-document';
  nodeId: string;
  payload: DocumentPayload;
}

export interface MoveNodesCommand extends DesktopPlacementCommand {
  type: 'move-nodes';
  nodeIds: string[];
  parentId: string;
  placements?: NodeIconPlacement[];
}

export interface DuplicateNodesCommand {
  type: 'duplicate-nodes';
  nodeIds: string[];
  parentId: string;
}

export interface EmptyTrashCommand {
  type: 'empty-trash';
}

/** Renderer-callable filesystem commands. Host imports use the internal command below. */
export type VfsCommand =
  | CreateFolderCommand
  | CreateDocumentCommand
  | UpdateDocumentCommand
  | MoveNodesCommand
  | DuplicateNodesCommand
  | EmptyTrashCommand;

/** Main-process-only command created after host paths have been inspected. */
export interface MergeImportedEntriesCommand extends DesktopPlacementCommand {
  type: 'merge-imported-entries';
  entries: ImportedEntry[];
  parentId: string;
}

export type ExecutableVfsCommand = VfsCommand | MergeImportedEntriesCommand;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
};

const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isPoint = (value: unknown): value is Point =>
  isRecord(value) &&
  hasOnlyKeys(value, ['x', 'y']) &&
  typeof value.x === 'number' &&
  Number.isFinite(value.x) &&
  typeof value.y === 'number' &&
  Number.isFinite(value.y);

const isDesktopPlacement = (value: unknown): value is DesktopPlacement =>
  isRecord(value) &&
  hasOnlyKeys(value, ['point', 'surfaceSize']) &&
  isPoint(value.point) &&
  isRecord(value.surfaceSize) &&
  hasOnlyKeys(value.surfaceSize, ['width', 'height']) &&
  typeof value.surfaceSize.width === 'number' &&
  Number.isFinite(value.surfaceSize.width) &&
  value.surfaceSize.width >= 0 &&
  value.surfaceSize.width <= 16_384 &&
  typeof value.surfaceSize.height === 'number' &&
  Number.isFinite(value.surfaceSize.height) &&
  value.surfaceSize.height >= 0 &&
  value.surfaceSize.height <= 16_384;

const hasValidOptionalDesktopPlacement = (
  value: Record<string, unknown>,
  parentId: string,
): boolean =>
  value.desktopPlacement === undefined ||
  (parentId === 'desktop' && isDesktopPlacement(value.desktopPlacement));

const isNodeIdArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= MAX_VFS_NODES &&
  value.every((item) => isBoundedString(item, 96));

const isNodeIconPlacement = (value: unknown): value is NodeIconPlacement =>
  isRecord(value) &&
  hasOnlyKeys(value, ['nodeId', 'position']) &&
  isBoundedString(value.nodeId, 96) &&
  isPoint(value.position);

const isNodeIconPlacements = (value: unknown): value is NodeIconPlacement[] =>
  Array.isArray(value) &&
  value.length <= MAX_VFS_NODES &&
  value.every((item) => isNodeIconPlacement(item));

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));

const isOneOf = <Value extends string | number>(
  value: unknown,
  allowed: readonly Value[],
): value is Value => allowed.some((candidate) => candidate === value);

const isWriteParagraphStyleCandidate = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    'fontFamily',
    'fontSize',
    'alignment',
    'leftIndent',
    'firstLineIndent',
    'rightIndent',
    'tabStops',
    'lineSpacing',
  ]) &&
  isOneOf(value.fontFamily, WRITE_FONT_FAMILIES) &&
  isOneOf(value.fontSize, WRITE_FONT_SIZES) &&
  isOneOf(value.alignment, WRITE_ALIGNMENTS) &&
  typeof value.leftIndent === 'number' &&
  Number.isFinite(value.leftIndent) &&
  typeof value.firstLineIndent === 'number' &&
  Number.isFinite(value.firstLineIndent) &&
  typeof value.rightIndent === 'number' &&
  Number.isFinite(value.rightIndent) &&
  Array.isArray(value.tabStops) &&
  value.tabStops.length <= 32 &&
  value.tabStops.every((point) => typeof point === 'number' && Number.isFinite(point)) &&
  isOneOf(value.lineSpacing, WRITE_LINE_SPACINGS);

const isWriteInlineCandidate = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'tab') return hasOnlyKeys(value, ['type']);
  return (
    value.type === 'text' &&
    hasOnlyKeys(value, ['type', 'text', 'marks']) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    (value.marks === undefined ||
      (Array.isArray(value.marks) &&
        value.marks.length <= WRITE_MARK_TYPES.length &&
        value.marks.every(
          (mark) =>
            isRecord(mark) && hasOnlyKeys(mark, ['type']) && isOneOf(mark.type, WRITE_MARK_TYPES),
        )))
  );
};

const isDocumentPayloadCandidate = (value: unknown): value is DocumentPayload => {
  if (!isRecord(value)) return false;
  try {
    if (JSON.stringify(value).length > 1024 * 1024) return false;
  } catch {
    return false;
  }

  if (value.format === 'plain-text') {
    return hasOnlyKeys(value, ['format', 'text']) && typeof value.text === 'string';
  }
  if (
    value.format !== 'write-v1' ||
    value.pagePreset !== WRITE_PAGE_PRESET ||
    !hasOnlyKeys(value, ['format', 'pagePreset', 'blocks']) ||
    !Array.isArray(value.blocks) ||
    value.blocks.length === 0 ||
    value.blocks.length > MAX_WRITE_BLOCKS
  ) {
    return false;
  }

  let inlineCount = 0;
  for (const block of value.blocks) {
    if (!isRecord(block) || typeof block.type !== 'string') return false;
    if (block.type === 'page-break') {
      if (!hasOnlyKeys(block, ['type'])) return false;
      continue;
    }
    if (
      block.type !== 'paragraph' ||
      !hasOnlyKeys(block, ['type', 'style', 'content']) ||
      !isWriteParagraphStyleCandidate(block.style) ||
      !Array.isArray(block.content)
    ) {
      return false;
    }
    inlineCount += block.content.length;
    if (
      inlineCount > MAX_WRITE_INLINES ||
      !block.content.every((inline) => isWriteInlineCandidate(inline))
    ) {
      return false;
    }
  }
  return true;
};

const candidateDocumentTextLength = (payload: DocumentPayload): number => {
  if (payload.format === 'plain-text') {
    return typeof payload.text === 'string' ? payload.text.length : 0;
  }
  if (!Array.isArray(payload.blocks)) return 0;

  let length = Math.max(0, payload.blocks.length - 1);
  for (const block of payload.blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'page-break') {
      length += 1;
      continue;
    }
    if (block.type !== 'paragraph' || !Array.isArray(block.content)) continue;
    for (const inline of block.content) {
      if (!isRecord(inline)) continue;
      if (inline.type === 'tab') length += 1;
      if (inline.type === 'text' && typeof inline.text === 'string') length += inline.text.length;
    }
  }
  return length;
};

const isImportedEntries = (value: unknown): value is ImportedEntry[] => {
  if (!Array.isArray(value) || value.length > MAX_IMPORTED_ROOTS) return false;

  const seen = new WeakSet<object>();
  const pending = value.map((entry) => ({ entry, depth: 0 }));
  let entryCount = 0;
  let contentLength = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > MAX_IMPORTED_DEPTH || !isRecord(current.entry)) return false;
    if (seen.has(current.entry)) return false;
    seen.add(current.entry);
    entryCount += 1;
    if (entryCount > MAX_IMPORTED_ENTRIES) return false;

    const entry = current.entry;
    if (
      !hasOnlyKeys(entry, ['name', 'kind', 'content', 'createdAt', 'modifiedAt', 'children']) ||
      !isBoundedString(entry.name, 96) ||
      (entry.kind !== 'folder' && entry.kind !== 'document') ||
      !isTimestamp(entry.createdAt) ||
      !isTimestamp(entry.modifiedAt)
    ) {
      return false;
    }

    if (entry.kind === 'document') {
      if (
        entry.children !== undefined ||
        (entry.content !== undefined && typeof entry.content !== 'string')
      ) {
        return false;
      }
      contentLength += entry.content?.length ?? 0;
      if ((entry.content?.length ?? 0) > MAX_DOCUMENT_CONTENT || contentLength > MAX_VFS_CONTENT) {
        return false;
      }
      continue;
    }

    if (
      entry.content !== undefined ||
      (entry.children !== undefined && !Array.isArray(entry.children))
    ) {
      return false;
    }
    const children = entry.children ?? [];
    if (children.length > MAX_IMPORTED_ENTRIES - entryCount) return false;
    for (const child of children) pending.push({ entry: child, depth: current.depth + 1 });
  }

  return true;
};

export const isVfsCommand = (value: unknown): value is VfsCommand => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'create-folder':
      return (
        hasOnlyKeys(value, ['type', 'parentId', 'desktopPlacement']) &&
        isBoundedString(value.parentId, 96) &&
        value.parentId !== 'trash' &&
        hasValidOptionalDesktopPlacement(value, value.parentId)
      );
    case 'create-document':
      return (
        hasOnlyKeys(value, ['type', 'parentId', 'name', 'payload', 'desktopPlacement']) &&
        isBoundedString(value.parentId, 96) &&
        value.parentId !== 'trash' &&
        isBoundedString(value.name, 96) &&
        isDocumentPayloadCandidate(value.payload) &&
        hasValidOptionalDesktopPlacement(value, value.parentId)
      );
    case 'update-document':
      return (
        hasOnlyKeys(value, ['type', 'nodeId', 'payload']) &&
        isBoundedString(value.nodeId, 96) &&
        isDocumentPayloadCandidate(value.payload)
      );
    case 'move-nodes':
      return (
        hasOnlyKeys(value, ['type', 'nodeIds', 'parentId', 'placements', 'desktopPlacement']) &&
        isNodeIdArray(value.nodeIds) &&
        isBoundedString(value.parentId, 96) &&
        (value.placements === undefined || isNodeIconPlacements(value.placements)) &&
        hasValidOptionalDesktopPlacement(value, value.parentId) &&
        (value.placements === undefined || value.desktopPlacement === undefined)
      );
    case 'duplicate-nodes':
      return (
        hasOnlyKeys(value, ['type', 'nodeIds', 'parentId']) &&
        isNodeIdArray(value.nodeIds) &&
        isBoundedString(value.parentId, 96) &&
        value.parentId !== 'trash'
      );
    case 'empty-trash':
      return hasOnlyKeys(value, ['type']);
    default:
      return false;
  }
};

export const isMergeImportedEntriesCommand = (
  value: unknown,
): value is MergeImportedEntriesCommand =>
  isRecord(value) &&
  value.type === 'merge-imported-entries' &&
  hasOnlyKeys(value, ['type', 'entries', 'parentId', 'desktopPlacement']) &&
  isImportedEntries(value.entries) &&
  isBoundedString(value.parentId, 96) &&
  value.parentId !== 'trash' &&
  hasValidOptionalDesktopPlacement(value, value.parentId);

export const isExecutableVfsCommand = (value: unknown): value is ExecutableVfsCommand =>
  isVfsCommand(value) || isMergeImportedEntriesCommand(value);

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

const isWritableContainer = (node: VfsNode | undefined): boolean =>
  node?.kind === 'desktop' || node?.kind === 'disk' || node?.kind === 'folder';

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
      node.id === 'trash' ||
      (node.kind !== 'folder' && node.kind !== 'document' && node.kind !== 'application')
    ) {
      return false;
    }
    const visited = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
};

const contentSize = (nodes: VfsNode[]): number =>
  nodes.reduce(
    (total, node) => total + (node.payload ? documentPayloadText(node.payload).length : 0),
    0,
  );

const validTimestamp = (value: string, fallback: string): string =>
  value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : fallback;

const importedTreeSize = (entry: ImportedEntry): number => {
  const seen = new Set<ImportedEntry>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    pending.push(...(current.children ?? []));
  }
  return seen.size;
};

export const moveNodes = (
  state: MacintoshState,
  nodeIds: Iterable<string>,
  parentId: string,
  timestamp = new Date().toISOString(),
): VfsMutationResult => {
  const parent = state.nodes.find((node) => node.id === parentId);
  if (!isContainer(parent)) {
    return { state, affectedIds: [], addedCount: 0, skippedCount: 0, truncatedCount: 0 };
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
      addedCount: 0,
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
    addedCount: 0,
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
  if (!isWritableContainer(parent)) {
    return { state, affectedIds: [], addedCount: 0, skippedCount: 0, truncatedCount: 0 };
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
    ancestry: ReadonlySet<string> = new Set(),
  ): VfsNode | null => {
    if (ancestry.has(source.id)) {
      skippedCount += 1;
      return null;
    }
    if (state.nodes.length + additions.length >= MAX_VFS_NODES) {
      skippedCount += 1 + descendantsOf(state.nodes, source.id).size;
      return null;
    }
    const id = uniqueId(source.kind, ids);
    let payload = source.payload;
    const payloadTextLength = payload ? documentPayloadText(payload).length : 0;
    if (payload && payloadTextLength > remainingContent) {
      payload = {
        format: 'plain-text',
        text: documentPayloadText(payload).slice(0, remainingContent),
      };
      remainingContent = 0;
      truncatedCount += 1;
    } else {
      remainingContent -= payloadTextLength;
    }
    const copy: VfsNode = {
      ...source,
      id,
      parentId: destinationId,
      name,
      iconPosition: retainIconPosition ? source.iconPosition : undefined,
      ...(payload === undefined ? {} : { payload }),
      createdAt: timestamp,
      modifiedAt: timestamp,
    };
    additions.push(copy);
    const childAncestry = new Set(ancestry);
    childAncestry.add(source.id);
    for (const child of byParent.get(source.id) ?? []) {
      clone(child, id, child.name, true, childAncestry);
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
    addedCount: additions.length,
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
  if (!isWritableContainer(parent)) {
    return {
      state,
      affectedIds: [],
      addedCount: 0,
      skippedCount: entries.length,
      truncatedCount: 0,
    };
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
    let payload: DocumentPayload | undefined =
      kind === 'document' ? { format: 'plain-text', text: entry.content ?? '' } : undefined;
    const payloadText = payload?.format === 'plain-text' ? payload.text : '';
    if (payload && payloadText.length > remainingContent) {
      payload = { format: 'plain-text', text: payloadText.slice(0, remainingContent) };
      remainingContent = 0;
      truncatedCount += 1;
    } else {
      remainingContent -= payloadText.length;
    }
    const node: VfsNode = {
      id: uniqueId(kind, ids),
      parentId: destinationId,
      name,
      kind,
      ...(payload === undefined ? {} : { payload }),
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
    addedCount: additions.length,
    skippedCount,
    truncatedCount,
  };
};

export const emptyTrash = (state: MacintoshState): MacintoshState => {
  const removed = descendantsOf(state.nodes, 'trash');
  removed.delete('desktop');
  removed.delete('system-disk');
  removed.delete('trash');
  if (removed.size === 0) return state;
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
  if (
    state.nodes.length >= MAX_VFS_NODES ||
    !isWritableContainer(state.nodes.find((node) => node.id === parentId))
  ) {
    return state;
  }
  const siblings = state.nodes.filter((node) => node.parentId === parentId);
  const names = new Set(siblings.map((node) => node.name.toLocaleLowerCase()));
  let name = 'untitled folder';
  let suffix = 2;
  while (names.has(name.toLocaleLowerCase())) {
    name = `untitled folder ${suffix}`;
    suffix += 1;
  }
  const id = uniqueId('folder', new Set(state.nodes.map((node) => node.id)));
  return {
    ...state,
    nodes: [
      ...state.nodes,
      {
        id,
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

const placeDesktopRoots = (
  state: MacintoshState,
  nodeIds: readonly string[],
  placement: DesktopPlacement,
): MacintoshState => {
  if (nodeIds.length === 0) return state;
  const maximumX = Math.max(0, Math.round(placement.surfaceSize.width) - DESKTOP_ICON_WIDTH);
  const maximumY = Math.max(0, Math.round(placement.surfaceSize.height) - DESKTOP_ICON_HEIGHT);
  const intervals = Math.max(1, nodeIds.length - 1);
  const step = {
    x: Math.min(DESKTOP_CASCADE_OFFSET.x, Math.floor(maximumX / intervals)),
    y: Math.min(DESKTOP_CASCADE_OFFSET.y, Math.floor(maximumY / intervals)),
  };
  const span = {
    x: step.x * (nodeIds.length - 1),
    y: step.y * (nodeIds.length - 1),
  };
  const origin = {
    x: Math.min(Math.max(0, Math.round(placement.point.x)), maximumX - span.x),
    y: Math.min(Math.max(0, Math.round(placement.point.y)), maximumY - span.y),
  };
  return placeFinderIcons(
    state,
    'desktop',
    nodeIds.map((nodeId, index) => ({
      nodeId,
      position: {
        x: origin.x + step.x * index,
        y: origin.y + step.y * index,
      },
    })),
  );
};

const applyMutationPlacements = (
  result: VfsMutationResult,
  parentId: string,
  placements: readonly NodeIconPlacement[] | undefined,
  desktopPlacement: DesktopPlacement | undefined,
): VfsMutationResult => {
  if (result.affectedIds.length === 0) return result;
  const affected = new Set(result.affectedIds);
  const state = placements
    ? placeFinderIcons(
        result.state,
        parentId,
        placements.filter((placement) => affected.has(placement.nodeId)),
      )
    : parentId === 'desktop' && desktopPlacement
      ? placeDesktopRoots(result.state, result.affectedIds, desktopPlacement)
      : result.state;
  return state === result.state ? result : { ...result, state };
};

const createFolderMutation = (
  state: MacintoshState,
  parentId: string,
  timestamp: string,
): VfsMutationResult => {
  const next = addFolder(state, parentId, timestamp);
  const created = next === state ? undefined : next.nodes[state.nodes.length];
  return {
    state: next,
    affectedIds: created ? [created.id] : [],
    addedCount: created ? 1 : 0,
    skippedCount: created ? 0 : 1,
    truncatedCount: 0,
  };
};

const createDocumentMutation = (
  state: MacintoshState,
  command: CreateDocumentCommand,
  timestamp: string,
): VfsMutationResult => {
  if (
    state.nodes.length >= MAX_VFS_NODES ||
    !isWritableContainer(state.nodes.find((node) => node.id === command.parentId))
  ) {
    return { state, affectedIds: [], addedCount: 0, skippedCount: 1, truncatedCount: 0 };
  }

  const names = new Set(
    state.nodes.filter((node) => node.parentId === command.parentId).map((node) => node.name),
  );
  const name = uniqueName(command.name, 'document', names);
  const remainingContent = Math.max(0, MAX_VFS_CONTENT - contentSize(state.nodes));
  const contentLimit = Math.min(MAX_DOCUMENT_CONTENT, remainingContent);
  const requestedTextLength = candidateDocumentTextLength(command.payload);
  const requestedPayload = sanitizeDocumentPayload(command.payload);
  const requestedText = documentPayloadText(requestedPayload);
  if (
    requestedTextLength > contentLimit ||
    requestedText.length !== requestedTextLength ||
    !documentPayloadEqual(command.payload, requestedPayload)
  ) {
    return { state, affectedIds: [], addedCount: 0, skippedCount: 1, truncatedCount: 1 };
  }
  const payload = requestedPayload;
  const id = uniqueId('document', new Set(state.nodes.map((node) => node.id)));
  return {
    state: {
      ...state,
      nodes: [
        ...state.nodes,
        {
          id,
          parentId: command.parentId,
          name,
          kind: 'document',
          payload,
          createdAt: timestamp,
          modifiedAt: timestamp,
        },
      ],
    },
    affectedIds: [id],
    addedCount: 1,
    skippedCount: 0,
    truncatedCount: 0,
  };
};

const updateDocumentMutation = (
  state: MacintoshState,
  command: UpdateDocumentCommand,
  timestamp: string,
): VfsMutationResult => {
  const target = state.nodes.find((node) => node.id === command.nodeId);
  if (!target || target.kind !== 'document') {
    return { state, affectedIds: [], addedCount: 0, skippedCount: 1, truncatedCount: 0 };
  }
  const otherContent =
    contentSize(state.nodes) - (target.payload ? documentPayloadText(target.payload).length : 0);
  const contentLimit = Math.min(MAX_DOCUMENT_CONTENT, Math.max(0, MAX_VFS_CONTENT - otherContent));
  const requestedTextLength = candidateDocumentTextLength(command.payload);
  const requestedPayload = sanitizeDocumentPayload(command.payload);
  const requestedText = documentPayloadText(requestedPayload);
  if (
    requestedTextLength > contentLimit ||
    requestedText.length !== requestedTextLength ||
    !documentPayloadEqual(command.payload, requestedPayload)
  ) {
    return { state, affectedIds: [], addedCount: 0, skippedCount: 1, truncatedCount: 1 };
  }
  const payload = requestedPayload;
  if (target.payload && documentPayloadEqual(target.payload, payload)) {
    return { state, affectedIds: [target.id], addedCount: 0, skippedCount: 0, truncatedCount: 0 };
  }
  return {
    state: {
      ...state,
      nodes: state.nodes.map((node) =>
        node.id === target.id ? { ...node, payload, modifiedAt: timestamp } : node,
      ),
    },
    affectedIds: [target.id],
    addedCount: 0,
    skippedCount: 0,
    truncatedCount: 0,
  };
};

const emptyTrashMutation = (state: MacintoshState): VfsMutationResult => {
  const affectedIds = state.nodes
    .filter((node) => node.parentId === 'trash' && node.id !== 'trash')
    .map((node) => node.id);
  return {
    state: emptyTrash(state),
    affectedIds,
    addedCount: 0,
    skippedCount: 0,
    truncatedCount: 0,
  };
};

export const executeVfsCommand = (
  state: MacintoshState,
  value: unknown,
  timestamp = new Date().toISOString(),
): VfsMutationResult => {
  if (!isExecutableVfsCommand(value)) {
    throw new TypeError('Invalid VFS command.');
  }
  const safeTimestamp = validTimestamp(timestamp, new Date().toISOString());

  switch (value.type) {
    case 'create-folder':
      return applyMutationPlacements(
        createFolderMutation(state, value.parentId, safeTimestamp),
        value.parentId,
        undefined,
        value.desktopPlacement,
      );
    case 'create-document':
      return applyMutationPlacements(
        createDocumentMutation(state, value, safeTimestamp),
        value.parentId,
        undefined,
        value.desktopPlacement,
      );
    case 'update-document':
      return updateDocumentMutation(state, value, safeTimestamp);
    case 'move-nodes':
      return applyMutationPlacements(
        moveNodes(state, value.nodeIds, value.parentId, safeTimestamp),
        value.parentId,
        value.placements,
        value.desktopPlacement,
      );
    case 'duplicate-nodes':
      return applyMutationPlacements(
        duplicateNodes(state, value.nodeIds, value.parentId, safeTimestamp),
        value.parentId,
        undefined,
        undefined,
      );
    case 'empty-trash':
      return emptyTrashMutation(state);
    case 'merge-imported-entries':
      return applyMutationPlacements(
        mergeImportedEntries(state, value.entries, value.parentId),
        value.parentId,
        undefined,
        value.desktopPlacement,
      );
  }
};
