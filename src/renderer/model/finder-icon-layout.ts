import type { Point, VfsNode } from '../../shared/state';
import { translateVfsIconDrag, type VfsIconDragLayout } from './vfs-drag';

export const FINDER_ICON_WIDTH = 112;
export const FINDER_ICON_HEIGHT = 84;

const FINDER_ICON_COLUMNS = 4;
const FINDER_ICON_ORIGIN: Point = { x: 24, y: 28 };
const FINDER_ICON_STEP: Point = { x: 144, y: 114 };
const FINDER_CANVAS_MINIMUM = { width: 610, height: 240 };
const FINDER_CANVAS_PADDING = { x: 42, y: 46 };

export const defaultFinderIconPosition = (index: number): Point => ({
  x: FINDER_ICON_ORIGIN.x + (index % FINDER_ICON_COLUMNS) * FINDER_ICON_STEP.x,
  y: FINDER_ICON_ORIGIN.y + Math.floor(index / FINDER_ICON_COLUMNS) * FINDER_ICON_STEP.y,
});

export const resolveFinderIconPosition = (node: VfsNode, index: number): Point =>
  node.iconPosition ?? defaultFinderIconPosition(index);

export const finderIconCanvasSize = (
  positions: Iterable<Point>,
): { width: number; height: number } => {
  let width = FINDER_CANVAS_MINIMUM.width;
  let height = FINDER_CANVAS_MINIMUM.height;
  for (const position of positions) {
    width = Math.max(width, position.x + FINDER_ICON_WIDTH + FINDER_CANVAS_PADDING.x);
    height = Math.max(height, position.y + FINDER_ICON_HEIGHT + FINDER_CANVAS_PADDING.y);
  }
  return { width, height };
};

export const translateFinderIconDrag = (
  layout: VfsIconDragLayout,
  dropPoint: Point,
): Record<string, Point> =>
  translateVfsIconDrag(layout, dropPoint, {
    minimumX: 0,
    minimumY: 0,
    maximumX: 8192,
    maximumY: 8192,
  });
