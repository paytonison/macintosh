import { initialDesktopIconPosition } from '../../shared/desktop-icon-position';
import type { Point, VfsNode } from '../../shared/state';
import type { FinderIconDragLayout } from './finder-icon-layout';
import { rectanglesOverlap, type NodeIconPlacement, type Rectangle } from './vfs';

export const DESKTOP_ICON_WIDTH = 82;
export const DESKTOP_ICON_HEIGHT = 78;

const IMPORT_GAP = 12;

export interface DesktopSurfaceSize {
  width: number;
  height: number;
}

export interface DesktopIconRectangle {
  id: string;
  bounds: Rectangle;
}

export const resolveDesktopIconPosition = (node: VfsNode): Point =>
  node.iconPosition ?? initialDesktopIconPosition(node.id);

const desktopDragBounds = (surface: DesktopSurfaceSize) => ({
  maximumX: Math.max(0, Math.round(surface.width) - DESKTOP_ICON_WIDTH),
  maximumY: Math.max(0, Math.round(surface.height) - DESKTOP_ICON_HEIGHT),
});

export const translateDesktopIconDrag = (
  layout: FinderIconDragLayout,
  dropPoint: Point,
  surface: DesktopSurfaceSize,
): Record<string, Point> | null => {
  const anchor = layout.positions[layout.anchorId];
  if (!anchor) return null;

  const anchorDestination = {
    x: Math.round(dropPoint.x - layout.pointerOffset.x),
    y: Math.round(dropPoint.y - layout.pointerOffset.y),
  };
  const delta = {
    x: anchorDestination.x - anchor.x,
    y: anchorDestination.y - anchor.y,
  };
  const translated = Object.entries(layout.positions).map(([id, position]) => [
    id,
    { x: position.x + delta.x, y: position.y + delta.y },
  ]) as Array<[string, Point]>;
  if (translated.length === 0) return {};

  const bounds = desktopDragBounds(surface);
  const minimumX = Math.min(...translated.map(([, position]) => position.x));
  const minimumY = Math.min(...translated.map(([, position]) => position.y));
  const maximumX = Math.max(...translated.map(([, position]) => position.x));
  const maximumY = Math.max(...translated.map(([, position]) => position.y));
  if (maximumX - minimumX > bounds.maximumX || maximumY - minimumY > bounds.maximumY) {
    return null;
  }
  const correction = {
    x: minimumX < 0 ? -minimumX : maximumX > bounds.maximumX ? bounds.maximumX - maximumX : 0,
    y: minimumY < 0 ? -minimumY : maximumY > bounds.maximumY ? bounds.maximumY - maximumY : 0,
  };

  return Object.fromEntries(
    translated.map(([id, position]) => [
      id,
      { x: position.x + correction.x, y: position.y + correction.y },
    ]),
  );
};

export const placeImportedDesktopRoots = (
  nodeIds: readonly string[],
  dropPoint: Point,
  surface: DesktopSurfaceSize,
): NodeIconPlacement[] => {
  if (nodeIds.length === 0) return [];
  const bounds = desktopDragBounds(surface);
  const step = {
    x: DESKTOP_ICON_WIDTH + IMPORT_GAP,
    y: DESKTOP_ICON_HEIGHT + IMPORT_GAP,
  };
  const availableColumns = Math.max(1, Math.floor(bounds.maximumX / step.x) + 1);
  const availableRows = Math.max(1, Math.floor(bounds.maximumY / step.y) + 1);
  const columns = Math.min(nodeIds.length, availableColumns);
  const rows = Math.min(Math.ceil(nodeIds.length / columns), availableRows);
  const capacity = columns * rows;
  const span = {
    x: step.x * (columns - 1),
    y: step.y * (rows - 1),
  };
  const origin = {
    x: Math.min(Math.max(0, Math.round(dropPoint.x)), Math.max(0, bounds.maximumX - span.x)),
    y: Math.min(Math.max(0, Math.round(dropPoint.y)), Math.max(0, bounds.maximumY - span.y)),
  };

  return nodeIds.map((nodeId, index) => {
    const slot = index % capacity;
    return {
      nodeId,
      position: {
        x: origin.x + step.x * (slot % columns),
        y: origin.y + step.y * Math.floor(slot / columns),
      },
    };
  });
};

export const desktopIconIdsInRectangle = (
  selection: Rectangle,
  icons: readonly DesktopIconRectangle[],
): string[] =>
  icons.flatMap((icon) => (rectanglesOverlap(selection, icon.bounds) ? [icon.id] : []));
