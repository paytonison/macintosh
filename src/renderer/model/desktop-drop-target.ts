import type { Point } from '../../shared/state';

export interface ClientBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// A few CSS pixels forgive a near-edge release without turning the label or
// the desktop icon's wide transparent button margins into Trash targets.
export const TRASH_DROP_TOLERANCE_CSS_PX = 4;

const containsPoint = (point: Point, bounds: ClientBounds, padding = 0): boolean =>
  point.x >= bounds.left - padding &&
  point.x <= bounds.right + padding &&
  point.y >= bounds.top - padding &&
  point.y <= bounds.bottom + padding;

export const isPointInTrashDropBounds = (
  point: Point,
  glyphBounds: ClientBounds,
  labelBounds: ClientBounds | null = null,
): boolean => {
  if (labelBounds && containsPoint(point, labelBounds)) return false;
  return containsPoint(point, glyphBounds, TRASH_DROP_TOLERANCE_CSS_PX);
};

export const isTrashDropPoint = (point: Point, trashElement: Element): boolean => {
  const glyph = trashElement.querySelector<SVGGraphicsElement>('[data-trash-drop-bounds="true"]');
  if (!glyph) return false;

  const label = trashElement.querySelector<HTMLElement>('[data-desktop-icon-label="trash"]');
  return isPointInTrashDropBounds(
    point,
    glyph.getBoundingClientRect(),
    label?.getBoundingClientRect() ?? null,
  );
};
