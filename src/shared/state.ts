export const STATE_SCHEMA_VERSION = 1 as const;

export type VfsNodeKind = 'disk' | 'trash' | 'folder' | 'document';
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
  content?: string;
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
  content?: string,
): VfsNode => ({
  id,
  parentId,
  name,
  kind,
  ...(content ? { content } : {}),
  createdAt: seedTimestamp,
  modifiedAt: seedTimestamp,
});

export const createDefaultState = (): MacintoshState => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  desktop: {
    diskPosition: { x: 1036, y: 52 },
    trashPosition: { x: 1040, y: 626 },
    windows: [
      {
        id: 'window-system-disk',
        nodeId: 'system-disk',
        x: 238,
        y: 106,
        width: 676,
        height: 442,
      },
    ],
    viewMode: 'icons',
    lastEjectAt: null,
  },
  nodes: [
    seedNode('system-disk', null, 'System Disk', 'disk'),
    seedNode('trash', null, 'Trash', 'trash'),
    seedNode('system-folder', 'system-disk', 'System Folder', 'folder'),
    seedNode('applications', 'system-disk', 'Applications', 'folder'),
    seedNode('documents', 'system-disk', 'Documents', 'folder'),
    seedNode('utilities', 'system-disk', 'Utilities', 'folder'),
    seedNode(
      'welcome',
      'system-disk',
      'Welcome',
      'document',
      'Welcome to The Macintosh.\n\nThis clean-room desktop is built from original code and original bitmap artwork. Double-click folders, drag icons, open the menus, and drag System Disk to Trash when it is time to shut down.',
    ),
    seedNode(
      'finder-notes',
      'system-folder',
      'Finder Notes',
      'document',
      'The Finder keeps the desktop orderly, remembers your windows, and stores this virtual disk locally.',
    ),
    seedNode(
      'read-me',
      'documents',
      'Read Me',
      'document',
      'No ROMs, copied system files, or extracted proprietary artwork are used by this application.',
    ),
  ],
});

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

const validKinds = new Set<VfsNodeKind>(['disk', 'trash', 'folder', 'document']);

const sanitizeNode = (value: unknown): VfsNode | null => {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (typeof kind !== 'string' || !validKinds.has(kind as VfsNodeKind)) return null;
  const id = safeString(value.id, '', 96);
  const name = safeString(value.name, '', 96);
  if (!id || !name) return null;
  const createdAt = safeTimestamp(value.createdAt, seedTimestamp) ?? seedTimestamp;
  const modifiedAt = safeTimestamp(value.modifiedAt, createdAt) ?? createdAt;
  return {
    id,
    parentId: value.parentId === null ? null : safeString(value.parentId, 'system-disk', 96),
    name,
    kind: kind as VfsNodeKind,
    ...(typeof value.content === 'string' ? { content: value.content.slice(0, 64 * 1024) } : {}),
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

export const sanitizeState = (value: unknown): MacintoshState => {
  const fallback = createDefaultState();
  if (!isRecord(value) || value.schemaVersion !== STATE_SCHEMA_VERSION) return fallback;

  const desktop = isRecord(value.desktop) ? value.desktop : {};
  const nodes = Array.isArray(value.nodes)
    ? value.nodes
        .map(sanitizeNode)
        .filter((node): node is VfsNode => node !== null)
        .slice(0, 512)
    : fallback.nodes;

  const hasDisk = nodes.some((node) => node.id === 'system-disk' && node.kind === 'disk');
  const hasTrash = nodes.some((node) => node.id === 'trash' && node.kind === 'trash');
  const safeNodes = hasDisk && hasTrash ? nodes : fallback.nodes;
  const nodeIds = new Set(safeNodes.map((node) => node.id));
  const windows = Array.isArray(desktop.windows)
    ? desktop.windows
        .map(sanitizeWindow)
        .filter((item): item is FinderWindowState => item !== null && nodeIds.has(item.nodeId))
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
