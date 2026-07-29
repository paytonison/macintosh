import type { Point, VfsNode } from '../../shared/state';
import { initialDesktopIconPosition } from '../../shared/desktop-icon-position';
import { rectanglesOverlap, type Rectangle } from '../../shared/vfs';
import { translateVfsIconDrag, type VfsIconDragLayout } from './vfs-drag';

export const DESKTOP_ICON_WIDTH = 82;
export const DESKTOP_ICON_HEIGHT = 78;

export interface DesktopSurfaceSize {
  width: number;
  height: number;
}

export interface DesktopIconRectangle {
  id: string;
  bounds: Rectangle;
}

export const defaultDesktopIconPosition = (nodeId: string): Point =>
  initialDesktopIconPosition(nodeId);

export const resolveDesktopIconPosition = (node: VfsNode): Point =>
  node.iconPosition ?? initialDesktopIconPosition(node.id);

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

export const desktopIconIdsInRectangle = (
  selection: Rectangle,
  icons: readonly DesktopIconRectangle[],
): string[] =>
  icons.flatMap((icon) => (rectanglesOverlap(selection, icon.bounds) ? [icon.id] : []));
