import type { Point, VfsNode } from '../../shared/state';
import { initialDesktopIconPosition } from '../../shared/desktop-icon-position';
import { rectanglesOverlap, type NodeIconPlacement, type Rectangle } from '../../shared/vfs';
import { orderNodesForIconCleanup } from './icon-cleanup-order';
import { translateVfsIconDrag, type VfsIconDragLayout } from './vfs-drag';

export const DESKTOP_ICON_WIDTH = 82;
export const DESKTOP_ICON_HEIGHT = 78;

const DESKTOP_CLEANUP_DISK_Y = 7;
const DESKTOP_CLEANUP_FIRST_ITEM_Y = 77;
const DESKTOP_CLEANUP_ROW_STEP = 83;
const DESKTOP_CLEANUP_TRASH_BOTTOM_INSET = 15;

export interface DesktopSurfaceSize {
  width: number;
  height: number;
}

export interface DesktopIconRectangle {
  id: string;
  hitRegions: readonly Rectangle[];
}

export const desktopCleanupColumnX = (surface: DesktopSurfaceSize): number =>
  Math.max(0, Math.round(surface.width) - DESKTOP_ICON_WIDTH);

export const desktopCleanupSpecialIconPositions = (
  surface: DesktopSurfaceSize,
): { diskPosition: Point; trashPosition: Point } => {
  const cleanupColumnX = desktopCleanupColumnX(surface);
  const maximumY = Math.max(0, Math.round(surface.height) - DESKTOP_ICON_HEIGHT);

  return {
    diskPosition: {
      x: cleanupColumnX,
      y: Math.min(DESKTOP_CLEANUP_DISK_Y, maximumY),
    },
    trashPosition: {
      x: cleanupColumnX,
      y: Math.max(0, maximumY - DESKTOP_CLEANUP_TRASH_BOTTOM_INSET),
    },
  };
};

export const defaultDesktopIconPosition = (nodeId: string): Point =>
  initialDesktopIconPosition(nodeId);

export const resolveDesktopIconPosition = (node: VfsNode): Point =>
  node.iconPosition ?? initialDesktopIconPosition(node.id);

export const cleanUpDesktopIconPositions = (
  nodes: readonly VfsNode[],
  surface: DesktopSurfaceSize,
  reservedRectangles: readonly Rectangle[],
): NodeIconPlacement[] | null => {
  const orderedNodes = orderNodesForIconCleanup(nodes);
  if (orderedNodes.length === 0) return [];

  const width = Math.round(surface.width);
  const height = Math.round(surface.height);
  if (width < DESKTOP_ICON_WIDTH || height < DESKTOP_ICON_HEIGHT) return null;

  const maximumX = desktopCleanupColumnX(surface);
  const maximumY = height - DESKTOP_ICON_HEIGHT;
  const columnCount = Math.floor(maximumX / DESKTOP_ICON_WIDTH) + 1;
  const rowCount =
    maximumY < DESKTOP_CLEANUP_FIRST_ITEM_Y
      ? 0
      : Math.floor((maximumY - DESKTOP_CLEANUP_FIRST_ITEM_Y) / DESKTOP_CLEANUP_ROW_STEP) + 1;
  const placements: NodeIconPlacement[] = [];

  for (let column = 0; column < columnCount; column += 1) {
    const x = maximumX - column * DESKTOP_ICON_WIDTH;
    for (let row = 0; row < rowCount; row += 1) {
      const y = DESKTOP_CLEANUP_FIRST_ITEM_Y + row * DESKTOP_CLEANUP_ROW_STEP;
      const candidate = {
        left: x,
        top: y,
        right: x + DESKTOP_ICON_WIDTH,
        bottom: y + DESKTOP_ICON_HEIGHT,
      };
      if (reservedRectangles.some((reserved) => rectanglesOverlap(candidate, reserved))) continue;

      const node = orderedNodes[placements.length];
      if (!node) return placements;
      placements.push({ nodeId: node.id, position: { x, y } });
    }
  }

  return placements.length === orderedNodes.length ? placements : null;
};

const desktopDragBounds = (surface: DesktopSurfaceSize) => ({
  minimumX: 0,
  minimumY: 0,
  maximumX: Math.max(0, Math.round(surface.width) - DESKTOP_ICON_WIDTH),
  maximumY: Math.max(0, Math.round(surface.height) - DESKTOP_ICON_HEIGHT),
});

export const translateDesktopIconDrag = (
  layout: VfsIconDragLayout,
  dropPoint: Point,
  surface: DesktopSurfaceSize,
): Record<string, Point> | null => {
  const positions = Object.values(layout.positions);
  if (positions.length > 0) {
    const bounds = desktopDragBounds(surface);
    const spanX =
      Math.max(...positions.map(({ x }) => x)) - Math.min(...positions.map(({ x }) => x));
    const spanY =
      Math.max(...positions.map(({ y }) => y)) - Math.min(...positions.map(({ y }) => y));
    if (spanX > bounds.maximumX - bounds.minimumX || spanY > bounds.maximumY - bounds.minimumY) {
      return null;
    }
  }

  return translateVfsIconDrag(layout, dropPoint, desktopDragBounds(surface));
};

export const desktopIconIdsInRectangle = (
  selection: Rectangle,
  icons: readonly DesktopIconRectangle[],
): string[] =>
  icons.flatMap((icon) =>
    icon.hitRegions.some((region) => rectanglesOverlap(selection, region)) ? [icon.id] : [],
  );
