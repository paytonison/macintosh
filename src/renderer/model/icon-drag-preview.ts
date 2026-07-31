import type { Point } from '../../shared/state';

export interface IconDragPreviewSource {
  nodeId: string;
  bounds: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface IconDragPreviewItem {
  nodeId: string;
  offsetFromPointer: Point;
  size: number;
}

export const createIconDragPreviewItems = (
  sources: IconDragPreviewSource[],
  pointer: Point,
): IconDragPreviewItem[] =>
  sources.flatMap(({ bounds, nodeId }) => {
    const values = [bounds.left, bounds.top, bounds.width, bounds.height, pointer.x, pointer.y];
    if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return [];
    return [
      {
        nodeId,
        offsetFromPointer: {
          x: Math.round(bounds.left - pointer.x),
          y: Math.round(bounds.top - pointer.y),
        },
        size: Math.max(1, Math.round(Math.min(bounds.width, bounds.height))),
      },
    ];
  });

export const resolveIconDragPreviewPosition = (
  item: IconDragPreviewItem,
  pointer: Point,
): Point => ({
  x: Math.round(pointer.x + item.offsetFromPointer.x),
  y: Math.round(pointer.y + item.offsetFromPointer.y),
});
