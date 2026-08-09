import type { Point, VfsNode } from '../../shared/state';
import type { NodeIconPlacement } from '../../shared/vfs';
import { orderNodesForIconCleanup } from './icon-cleanup-order';
import { translateVfsIconDrag, type VfsIconDragLayout } from './vfs-drag';

export const FINDER_ICON_WIDTH = 112;
export const FINDER_ICON_HEIGHT = 84;

const FINDER_ICON_COLUMNS = 4;
const FINDER_ICON_ORIGIN: Point = { x: 24, y: 28 };
const FINDER_ICON_STEP: Point = { x: 144, y: 114 };
const MAX_FINDER_ICON_POSITION = 8192;
const FINDER_ICON_ROWS_PER_BAND =
  Math.floor((MAX_FINDER_ICON_POSITION - FINDER_ICON_ORIGIN.y) / FINDER_ICON_STEP.y) + 1;
const FINDER_ICONS_PER_BAND = FINDER_ICON_COLUMNS * FINDER_ICON_ROWS_PER_BAND;
const FINDER_CANVAS_MINIMUM = { width: 610, height: 240 };
const FINDER_CANVAS_PADDING = { x: 42, y: 46 };

export const defaultFinderIconPosition = (index: number): Point => {
  const band = Math.floor(index / FINDER_ICONS_PER_BAND);
  const indexWithinBand = index % FINDER_ICONS_PER_BAND;
  return {
    x:
      FINDER_ICON_ORIGIN.x +
      (band * FINDER_ICON_COLUMNS + (indexWithinBand % FINDER_ICON_COLUMNS)) * FINDER_ICON_STEP.x,
    y:
      FINDER_ICON_ORIGIN.y + Math.floor(indexWithinBand / FINDER_ICON_COLUMNS) * FINDER_ICON_STEP.y,
  };
};

export const cleanUpFinderIconPositions = (nodes: readonly VfsNode[]): NodeIconPlacement[] =>
  orderNodesForIconCleanup(nodes).map((node, index) => ({
    nodeId: node.id,
    position: defaultFinderIconPosition(index),
  }));

export const resolveFinderIconPositions = (nodes: readonly VfsNode[]): Map<string, Point> => {
  const fallbackIndex = new Map(
    [...nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node, index) => [node.id, index] as const),
  );
  return new Map(
    nodes.map((node) => [
      node.id,
      node.iconPosition ?? defaultFinderIconPosition(fallbackIndex.get(node.id) ?? 0),
    ]),
  );
};

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
    maximumX: MAX_FINDER_ICON_POSITION,
    maximumY: MAX_FINDER_ICON_POSITION,
  });
