import { initialDesktopIconPosition } from './desktop-icon-position';
import {
  DEFAULT_DESKTOP_SURFACE_SIZE,
  desktopCleanupItemPosition,
  desktopCleanupSpecialIconPositions,
  type DesktopSurfaceSize,
} from './desktop-layout';
import { sanitizeDocumentPayload, type DocumentPayload } from './write';

export const STATE_SCHEMA_VERSION = 4 as const;
const LEGACY_STATE_SCHEMA_VERSIONS = new Set([1, 2, 3]);
export const MAX_VFS_NAME_LENGTH = 96;
// Schema 2 allowed two required roots plus 510 ordinary nodes. Schema 3 added
// Desktop and schema 4 adds Write without reducing that user-visible capacity.
export const MAX_VFS_NODES = 514;
export const SYSTEM_DISK_CREATED_AT = '1984-01-24T00:00:00.000Z';
export const BUILT_IN_ITEM_CREATED_AT = '1984-01-24T00:00:00.000Z';

const CANONICAL_CREATED_AT_BY_NODE_ID = new Map<string, string>([
  ['system-disk', SYSTEM_DISK_CREATED_AT],
  ['trash', BUILT_IN_ITEM_CREATED_AT],
  ['system-folder', BUILT_IN_ITEM_CREATED_AT],
  ['applications', BUILT_IN_ITEM_CREATED_AT],
  ['documents', BUILT_IN_ITEM_CREATED_AT],
  ['utilities', BUILT_IN_ITEM_CREATED_AT],
  ['welcome', BUILT_IN_ITEM_CREATED_AT],
  ['finder-notes', BUILT_IN_ITEM_CREATED_AT],
  ['read-me', BUILT_IN_ITEM_CREATED_AT],
  ['write', BUILT_IN_ITEM_CREATED_AT],
  ['trash-untitled-folder', BUILT_IN_ITEM_CREATED_AT],
  ['trash-all-work', BUILT_IN_ITEM_CREATED_AT],
  ['trash-untitled-folder-2', BUILT_IN_ITEM_CREATED_AT],
  ['trash-untitled-folder-3', BUILT_IN_ITEM_CREATED_AT],
]);

export const canonicalCreatedAtForNodeId = (nodeId: string): string | null =>
  CANONICAL_CREATED_AT_BY_NODE_ID.get(nodeId) ?? null;

export type VfsNodeKind = 'desktop' | 'disk' | 'trash' | 'folder' | 'document' | 'application';
export type ApplicationId = 'write';
export type FinderViewMode = 'icons' | 'list';

export interface Point {
  x: number;
  y: number;
}

export interface WindowGeometry extends Point {
  width: number;
  height: number;
}

export interface FinderWindowState extends WindowGeometry {
  id: string;
  nodeId: string;
}

export interface VfsNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: VfsNodeKind;
  payload?: DocumentPayload;
  applicationId?: ApplicationId;
  iconPosition?: Point;
  createdAt: string;
  modifiedAt: string;
}

export interface DesktopState {
  diskPosition: Point;
  trashPosition: Point;
  windows: FinderWindowState[];
  viewMode: FinderViewMode;
  lastEjectAt: string | null;
}

export interface MacintoshState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  desktop: DesktopState;
  nodes: VfsNode[];
}

const seedTimestamp = '1989-01-24T09:00:00.000Z';

const seedNode = (
  id: string,
  parentId: string | null,
  name: string,
  kind: VfsNodeKind,
  payload?: DocumentPayload,
  applicationId?: ApplicationId,
  iconPosition?: Point,
): VfsNode => ({
  id,
  parentId,
  name,
  kind,
  ...(payload ? { payload } : {}),
  ...(applicationId ? { applicationId } : {}),
  ...(iconPosition ? { iconPosition } : {}),
  createdAt: canonicalCreatedAtForNodeId(id) ?? seedTimestamp,
  modifiedAt: seedTimestamp,
});

export const createDefaultState = (
  surface: DesktopSurfaceSize = DEFAULT_DESKTOP_SURFACE_SIZE,
): MacintoshState => {
  const { diskPosition, trashPosition } = desktopCleanupSpecialIconPositions(surface);
  const readMePosition = desktopCleanupItemPosition(surface, 0);

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    desktop: {
      diskPosition,
      trashPosition,
      windows: [],
      viewMode: 'icons',
      lastEjectAt: null,
    },
    nodes: [
      seedNode('system-disk', null, 'System Disk', 'disk'),
      seedNode('trash', null, 'Trash', 'trash'),
      seedNode('desktop', null, 'Desktop', 'desktop'),
      seedNode('system-folder', 'system-disk', 'System Folder', 'folder', undefined, undefined, {
        x: 265,
        y: 43,
      }),
      seedNode('applications', 'system-disk', 'Applications', 'folder', undefined, undefined, {
        x: 118,
        y: 67,
      }),
      seedNode('documents', 'system-disk', 'Documents', 'folder', undefined, undefined, {
        x: 216,
        y: 183,
      }),
      seedNode('write', 'applications', 'Write', 'application', undefined, 'write'),
      seedNode(
        'welcome',
        'documents',
        'Welcome',
        'document',
        {
          format: 'plain-text',
          text: 'Welcome to The Macintosh.\nThis clean-room desktop is built from original code and original bitmap artwork. Double-click folders, drag icons, open the menus, and drag System Disk to Trash when it is time to shut down.',
        },
        undefined,
        { x: 24, y: 28 },
      ),
      seedNode(
        'finder-notes',
        'system-folder',
        'Finder Notes',
        'document',
        {
          format: 'plain-text',
          text: 'The Finder keeps the desktop orderly, remembers your windows, and stores this virtual disk locally.',
        },
        undefined,
        { x: 32, y: 84 },
      ),
      seedNode(
        'read-me',
        'desktop',
        'Read Me',
        'document',
        {
          format: 'plain-text',
          text: 'No ROMs, copied system files, or extracted proprietary artwork are used by this application.',
        },
        undefined,
        readMePosition,
      ),
      seedNode(
        'trash-untitled-folder',
        'trash',
        'untitled folder',
        'folder',
        undefined,
        undefined,
        { x: 24, y: 28 },
      ),
      seedNode(
        'trash-all-work',
        'trash-untitled-folder',
        'all work and no play makes jack a dull boy',
        'document',
        {
          format: 'plain-text',
          text: [
            'All work and no play makes Jack a dull boy.',
            'All work and no play makes Jack a dull boy.',
            'All work and no play makes Jack a dull boy.',
            'All work and no play makes Jack a dull boy.',
            'All work and no play makes Jack a dull boy.',
            'All work and no play makes Jack a dull boy.',
          ].join('\n'),
        },
        undefined,
        { x: 24, y: 28 },
      ),
      seedNode(
        'trash-untitled-folder-2',
        'trash-untitled-folder',
        'untitled folder 2',
        'folder',
        undefined,
        undefined,
        { x: 168, y: 28 },
      ),
      seedNode(
        'trash-untitled-folder-3',
        'trash-untitled-folder',
        'untitled folder 3',
        'folder',
        undefined,
        undefined,
        { x: 312, y: 28 },
      ),
    ],
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const safeString = (value: unknown, fallback: string, maximum: number): string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : fallback;

const safeTimestamp = (value: unknown, fallback: string | null): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) {
    return fallback;
  }
  return value;
};

const sanitizePoint = (value: unknown, fallback: Point): Point => {
  if (!isRecord(value)) return fallback;
  return {
    x: finiteNumber(value.x, fallback.x, -256, 8192),
    y: finiteNumber(value.y, fallback.y, -256, 8192),
  };
};

const sanitizeIconPosition = (value: unknown): Point | null => {
  if (
    !isRecord(value) ||
    typeof value.x !== 'number' ||
    !Number.isFinite(value.x) ||
    typeof value.y !== 'number' ||
    !Number.isFinite(value.y)
  ) {
    return null;
  }
  return {
    x: Math.round(Math.min(8192, Math.max(0, value.x))),
    y: Math.round(Math.min(8192, Math.max(0, value.y))),
  };
};

const validKinds = new Set<VfsNodeKind>([
  'desktop',
  'disk',
  'trash',
  'folder',
  'document',
  'application',
]);

const sanitizeNode = (value: unknown, legacy: boolean): VfsNode | null => {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (typeof kind !== 'string' || !validKinds.has(kind as VfsNodeKind)) return null;
  const id = safeString(value.id, '', 96);
  const name = safeString(value.name, '', MAX_VFS_NAME_LENGTH);
  if (!id || !name) return null;
  const createdAt = safeTimestamp(value.createdAt, seedTimestamp) ?? seedTimestamp;
  const modifiedAt = safeTimestamp(value.modifiedAt, createdAt) ?? createdAt;
  const parentId = value.parentId === null ? null : safeString(value.parentId, 'system-disk', 96);
  const iconPosition = parentId === null ? null : sanitizeIconPosition(value.iconPosition);
  const payload =
    kind === 'document'
      ? legacy && typeof value.content === 'string'
        ? sanitizeDocumentPayload({ format: 'plain-text', text: value.content })
        : sanitizeDocumentPayload(value.payload)
      : undefined;
  const applicationId = kind === 'application' && value.applicationId === 'write' ? 'write' : null;
  if (kind === 'application' && !applicationId) return null;
  return {
    id,
    parentId,
    name,
    kind: kind as VfsNodeKind,
    ...(payload ? { payload } : {}),
    ...(applicationId ? { applicationId } : {}),
    ...(iconPosition ? { iconPosition } : {}),
    createdAt,
    modifiedAt,
  };
};

const sanitizeWindow = (value: unknown): FinderWindowState | null => {
  if (!isRecord(value)) return null;
  const id = safeString(value.id, '', 96);
  const nodeId = safeString(value.nodeId, '', 96);
  if (!id || !nodeId) return null;
  return {
    id,
    nodeId,
    x: finiteNumber(value.x, 220, 0, 8192),
    y: finiteNumber(value.y, 90, 0, 8192),
    width: finiteNumber(value.width, 640, 300, 4096),
    height: finiteNumber(value.height, 420, 220, 4096),
  };
};

const requiredRoots = [
  { id: 'system-disk', kind: 'disk' },
  { id: 'trash', kind: 'trash' },
  { id: 'desktop', kind: 'desktop' },
] as const;

const ensureRequiredRoots = (nodes: VfsNode[], fallbackNodes: VfsNode[]): VfsNode[] => {
  const requirements = new Map<string, VfsNodeKind>(
    requiredRoots.map((root) => [root.id, root.kind]),
  );
  const seen = new Set<string>();
  const repaired: VfsNode[] = [];

  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const requiredKind = requirements.get(node.id);
    if (requiredKind && node.kind !== requiredKind) continue;
    if (
      !requiredKind &&
      (node.kind === 'desktop' || node.kind === 'disk' || node.kind === 'trash')
    ) {
      continue;
    }

    seen.add(node.id);
    if (requiredKind) {
      const root = { ...node };
      delete root.iconPosition;
      repaired.push({ ...root, parentId: null });
    } else {
      repaired.push(node);
    }
  }

  for (const requirement of requiredRoots) {
    if (seen.has(requirement.id)) continue;
    const fallback = fallbackNodes.find((node) => node.id === requirement.id);
    if (fallback) repaired.push({ ...fallback });
  }

  let overflow = repaired.length - MAX_VFS_NODES;
  for (let index = repaired.length - 1; index >= 0 && overflow > 0; index -= 1) {
    if (requirements.has(repaired[index]!.id)) continue;
    repaired.splice(index, 1);
    overflow -= 1;
  }

  return repaired;
};

const materializeDesktopIconPositions = (nodes: VfsNode[]): VfsNode[] =>
  nodes.map((node) =>
    node.parentId === 'desktop' &&
    (node.kind === 'folder' || node.kind === 'document' || node.kind === 'application') &&
    !node.iconPosition
      ? { ...node, iconPosition: initialDesktopIconPosition(node.id) }
      : node,
  );

const normalizeCanonicalCreatedAt = (node: VfsNode): VfsNode => {
  const createdAt = canonicalCreatedAtForNodeId(node.id);
  return createdAt && createdAt !== node.createdAt ? { ...node, createdAt } : node;
};

export const sanitizeState = (value: unknown): MacintoshState => {
  const fallback = createDefaultState();
  if (
    !isRecord(value) ||
    (value.schemaVersion !== STATE_SCHEMA_VERSION &&
      !LEGACY_STATE_SCHEMA_VERSIONS.has(value.schemaVersion as number))
  ) {
    return fallback;
  }

  const desktop = isRecord(value.desktop) ? value.desktop : {};
  const legacy = value.schemaVersion !== STATE_SCHEMA_VERSION;
  let nodes = Array.isArray(value.nodes)
    ? value.nodes
        .map((node) => sanitizeNode(node, legacy))
        .filter((node): node is VfsNode => node !== null)
        .slice(0, MAX_VFS_NODES)
    : fallback.nodes;

  if (
    legacy &&
    !nodes.some((node) => node.kind === 'application' && node.applicationId === 'write')
  ) {
    const write = fallback.nodes.find((node) => node.id === 'write');
    if (write && nodes.length < MAX_VFS_NODES) nodes = [...nodes, write];
  }

  const safeNodes = materializeDesktopIconPositions(
    ensureRequiredRoots(nodes, fallback.nodes).map(normalizeCanonicalCreatedAt),
  );
  const finderWindowNodeIds = new Set(
    safeNodes
      .filter((node) => node.kind === 'disk' || node.kind === 'folder' || node.kind === 'trash')
      .map((node) => node.id),
  );
  const windows = Array.isArray(desktop.windows)
    ? desktop.windows
        .map(sanitizeWindow)
        .filter(
          (item): item is FinderWindowState =>
            item !== null && finderWindowNodeIds.has(item.nodeId),
        )
        .slice(0, 12)
    : fallback.desktop.windows;

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    desktop: {
      diskPosition: sanitizePoint(desktop.diskPosition, fallback.desktop.diskPosition),
      trashPosition: sanitizePoint(desktop.trashPosition, fallback.desktop.trashPosition),
      windows,
      viewMode: desktop.viewMode === 'list' ? 'list' : 'icons',
      lastEjectAt: safeTimestamp(desktop.lastEjectAt, null),
    },
    nodes: safeNodes,
  };
};
