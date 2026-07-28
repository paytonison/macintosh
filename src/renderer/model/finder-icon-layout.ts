import type { Point, VfsNode } from '../../shared/state';

export const FINDER_ICON_WIDTH = 112;
export const FINDER_ICON_HEIGHT = 84;

const FINDER_ICON_COLUMNS = 4;
const FINDER_ICON_ORIGIN: Point = { x: 24, y: 28 };
const FINDER_ICON_STEP: Point = { x: 144, y: 114 };
const FINDER_CANVAS_MINIMUM = { width: 610, height: 240 };
const FINDER_CANVAS_PADDING = { x: 42, y: 46 };

export interface FinderIconDragLayout {
  anchorId: string;
  pointerOffset: Point;
  positions: Record<string, Point>;
}

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
  layout: FinderIconDragLayout,
  dropPoint: Point,
): Record<string, Point> => {
  const anchor = layout.positions[layout.anchorId];
  if (!anchor) return {};

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
  const minimumX = Math.min(...translated.map(([, position]) => position.x));
  const minimumY = Math.min(...translated.map(([, position]) => position.y));
  const maximumX = Math.max(...translated.map(([, position]) => position.x));
  const maximumY = Math.max(...translated.map(([, position]) => position.y));
  const correction = {
    x: minimumX < 0 ? -minimumX : maximumX > 8192 ? 8192 - maximumX : 0,
    y: minimumY < 0 ? -minimumY : maximumY > 8192 ? 8192 - maximumY : 0,
  };

  return Object.fromEntries(
    translated.map(([id, position]) => [
      id,
      {
        x: position.x + correction.x,
        y: position.y + correction.y,
      },
    ]),
  );
};
