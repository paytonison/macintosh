import type { Point, VfsNode } from '../../shared/state';
import { rectanglesOverlap, type NodeIconPlacement, type Rectangle } from './vfs';
import { translateVfsIconDrag, type VfsIconDragLayout } from './vfs-drag';

export const DESKTOP_ICON_WIDTH = 82;
export const DESKTOP_ICON_HEIGHT = 78;

const DESKTOP_ICON_ORIGIN: Point = { x: 24, y: 36 };
const DESKTOP_ICON_STEP: Point = { x: 96, y: 92 };
const DESKTOP_ICON_COLUMNS = 6;
const IMPORT_OFFSET: Point = { x: 13, y: 11 };

export interface DesktopSurfaceSize {
  width: number;
  height: number;
}

export interface DesktopIconRectangle {
  id: string;
  bounds: Rectangle;
}

export const defaultDesktopIconPosition = (index: number): Point => ({
  x: DESKTOP_ICON_ORIGIN.x + (index % DESKTOP_ICON_COLUMNS) * DESKTOP_ICON_STEP.x,
  y: DESKTOP_ICON_ORIGIN.y + Math.floor(index / DESKTOP_ICON_COLUMNS) * DESKTOP_ICON_STEP.y,
});

export const resolveDesktopIconPosition = (node: VfsNode, index: number): Point =>
  node.iconPosition ?? defaultDesktopIconPosition(index);

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
): Record<string, Point> => translateVfsIconDrag(layout, dropPoint, desktopDragBounds(surface));

export const placeImportedDesktopRoots = (
  nodeIds: readonly string[],
  dropPoint: Point,
  surface: DesktopSurfaceSize,
): NodeIconPlacement[] => {
  if (nodeIds.length === 0) return [];
  const bounds = desktopDragBounds(surface);
  const intervals = Math.max(1, nodeIds.length - 1);
  const step = {
    x: Math.max(1, Math.min(IMPORT_OFFSET.x, Math.floor(bounds.maximumX / intervals))),
    y: Math.max(1, Math.min(IMPORT_OFFSET.y, Math.floor(bounds.maximumY / intervals))),
  };
  const span = {
    x: step.x * (nodeIds.length - 1),
    y: step.y * (nodeIds.length - 1),
  };
  const origin = {
    x: Math.min(Math.max(0, Math.round(dropPoint.x)), Math.max(0, bounds.maximumX - span.x)),
    y: Math.min(Math.max(0, Math.round(dropPoint.y)), Math.max(0, bounds.maximumY - span.y)),
  };

  return nodeIds.map((nodeId, index) => ({
    nodeId,
    position: { x: origin.x + step.x * index, y: origin.y + step.y * index },
  }));
};

export const desktopIconIdsInRectangle = (
  selection: Rectangle,
  icons: readonly DesktopIconRectangle[],
): string[] =>
  icons.flatMap((icon) => (rectanglesOverlap(selection, icon.bounds) ? [icon.id] : []));
