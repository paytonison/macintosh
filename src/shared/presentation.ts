import {
  sanitizeState,
  type FinderViewMode,
  type FinderWindowState,
  type MacintoshState,
  type Point,
} from './state';

export interface IconPositionPatch {
  nodeId: string;
  parentId: string;
  position: Point;
}

export interface DesktopPresentation {
  diskPosition: Point;
  trashPosition: Point;
  windows: FinderWindowState[];
  viewMode: FinderViewMode;
}

export interface PresentationPatch {
  desktop: DesktopPresentation;
  iconPositions: IconPositionPatch[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFinitePoint = (value: unknown): value is Point =>
  isRecord(value) &&
  typeof value.x === 'number' &&
  Number.isFinite(value.x) &&
  typeof value.y === 'number' &&
  Number.isFinite(value.y);

const sanitizePatchPosition = (value: unknown): Point | null => {
  if (!isFinitePoint(value)) return null;

  return {
    x: Math.round(Math.min(8192, Math.max(0, value.x))),
    y: Math.round(Math.min(8192, Math.max(0, value.y))),
  };
};

const isValidWindowPatch = (
  value: unknown,
  validNodeIds: ReadonlySet<string>,
): value is FinderWindowState =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  value.id.length <= 96 &&
  typeof value.nodeId === 'string' &&
  value.nodeId.length > 0 &&
  value.nodeId.length <= 96 &&
  validNodeIds.has(value.nodeId) &&
  typeof value.x === 'number' &&
  Number.isFinite(value.x) &&
  typeof value.y === 'number' &&
  Number.isFinite(value.y) &&
  typeof value.width === 'number' &&
  Number.isFinite(value.width) &&
  typeof value.height === 'number' &&
  Number.isFinite(value.height);

const validatedWindows = (
  value: unknown,
  authoritative: MacintoshState,
): FinderWindowState[] | null => {
  if (!Array.isArray(value) || value.length > 12) return null;
  const validNodeIds = new Set(
    authoritative.nodes.filter((node) => node.kind !== 'desktop').map((node) => node.id),
  );
  if (!value.every((windowState) => isValidWindowPatch(windowState, validNodeIds))) return null;

  const windowIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (const windowState of value) {
    if (windowIds.has(windowState.id) || nodeIds.has(windowState.nodeId)) return null;
    windowIds.add(windowState.id);
    nodeIds.add(windowState.nodeId);
  }
  return value;
};

export const projectPresentation = (state: MacintoshState): PresentationPatch => {
  const { diskPosition, trashPosition, windows, viewMode } = state.desktop;
  return {
    desktop: { diskPosition, trashPosition, windows, viewMode },
    iconPositions: state.nodes.flatMap((node) =>
      node.parentId && node.iconPosition
        ? [
            {
              nodeId: node.id,
              parentId: node.parentId,
              position: node.iconPosition,
            },
          ]
        : [],
    ),
  };
};

export const mergePresentation = (
  authoritative: MacintoshState,
  value: unknown,
): MacintoshState => {
  if (!isRecord(value)) return authoritative;

  const desktopPatch = isRecord(value.desktop) ? value.desktop : {};
  const windows = validatedWindows(desktopPatch.windows, authoritative);
  const desktopCandidate = sanitizeState({
    ...authoritative,
    desktop: {
      ...authoritative.desktop,
      ...(isFinitePoint(desktopPatch.diskPosition)
        ? { diskPosition: desktopPatch.diskPosition }
        : {}),
      ...(isFinitePoint(desktopPatch.trashPosition)
        ? { trashPosition: desktopPatch.trashPosition }
        : {}),
      ...(windows ? { windows } : {}),
      ...(desktopPatch.viewMode === 'icons' || desktopPatch.viewMode === 'list'
        ? { viewMode: desktopPatch.viewMode }
        : {}),
    },
  }).desktop;
  const positions = new Map<string, { parentId: string; position: Point }>();

  if (Array.isArray(value.iconPositions)) {
    for (const item of value.iconPositions.slice(0, 512)) {
      if (!isRecord(item)) continue;
      const nodeId = typeof item.nodeId === 'string' ? item.nodeId.slice(0, 96) : '';
      const parentId = typeof item.parentId === 'string' ? item.parentId.slice(0, 96) : '';
      const position = sanitizePatchPosition(item.position);
      if (nodeId && parentId && position && !positions.has(nodeId)) {
        positions.set(nodeId, { parentId, position });
      }
    }
  }

  const nodes = authoritative.nodes.map((node) => {
    const patch = positions.get(node.id);
    if (
      !patch ||
      node.parentId === null ||
      patch.parentId !== node.parentId ||
      (node.iconPosition?.x === patch.position.x && node.iconPosition.y === patch.position.y)
    ) {
      return node;
    }
    return { ...node, iconPosition: patch.position };
  });

  return sanitizeState({
    ...authoritative,
    desktop: desktopCandidate,
    nodes,
  });
};
