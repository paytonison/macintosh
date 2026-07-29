import type { Point } from '../../shared/state';

export const VFS_DRAG_TYPE = 'application/x-macintosh-vfs-node-ids';

export interface VfsIconDragLayout {
  anchorId: string;
  pointerOffset: Point;
  positions: Record<string, Point>;
}

export interface VfsItemDragContext {
  parentId: string;
  nodeIds: string[];
  layout: VfsIconDragLayout;
  source: 'desktop' | 'finder';
}

export interface IconDragBounds {
  minimumX: number;
  minimumY: number;
  maximumX: number;
  maximumY: number;
}

export const writeVfsDragPayload = (
  dataTransfer: DataTransfer,
  nodeIds: readonly string[],
  names: readonly string[],
): void => {
  dataTransfer.effectAllowed = 'copyMove';
  dataTransfer.setData(VFS_DRAG_TYPE, JSON.stringify(nodeIds));
  dataTransfer.setData('text/plain', names.join('\n'));
};

export const translateVfsIconDrag = (
  layout: VfsIconDragLayout,
  dropPoint: Point,
  bounds: IconDragBounds,
): Record<string, Point> => {
  const anchor = layout.positions[layout.anchorId];
  if (!anchor) return {};

  const delta = {
    x: Math.round(dropPoint.x - layout.pointerOffset.x) - anchor.x,
    y: Math.round(dropPoint.y - layout.pointerOffset.y) - anchor.y,
  };
  const translated = Object.entries(layout.positions).map(([id, position]) => [
    id,
    { x: position.x + delta.x, y: position.y + delta.y },
  ]) as Array<[string, Point]>;
  if (translated.length === 0) return {};

  const minimumX = Math.min(...translated.map(([, position]) => position.x));
  const minimumY = Math.min(...translated.map(([, position]) => position.y));
  const maximumX = Math.max(...translated.map(([, position]) => position.x));
  const maximumY = Math.max(...translated.map(([, position]) => position.y));
  const correction = {
    x:
      minimumX < bounds.minimumX
        ? bounds.minimumX - minimumX
        : maximumX > bounds.maximumX
          ? bounds.maximumX - maximumX
          : 0,
    y:
      minimumY < bounds.minimumY
        ? bounds.minimumY - minimumY
        : maximumY > bounds.maximumY
          ? bounds.maximumY - maximumY
          : 0,
  };

  return Object.fromEntries(
    translated.map(([id, position]) => [
      id,
      { x: position.x + correction.x, y: position.y + correction.y },
    ]),
  );
};
