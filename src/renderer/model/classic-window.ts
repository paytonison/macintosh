import type { Point, WindowGeometry } from '../../shared/state';

export interface WindowSurfaceSize {
  width: number;
  height: number;
}

export interface ClassicWindowConstraints {
  minWidth: number;
  minHeight: number;
  minVisibleWidth?: number;
  minVisibleHeight?: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

export const previewWindowMove = (
  original: WindowGeometry,
  origin: Point,
  pointer: Point,
  surface: WindowSurfaceSize,
  constraints: ClassicWindowConstraints,
): WindowGeometry => ({
  ...original,
  x: clamp(
    Math.round(original.x + pointer.x - origin.x),
    0,
    Math.max(0, surface.width - (constraints.minVisibleWidth ?? 96)),
  ),
  y: clamp(
    Math.round(original.y + pointer.y - origin.y),
    0,
    Math.max(0, surface.height - (constraints.minVisibleHeight ?? 28)),
  ),
});

export const previewWindowResize = (
  original: WindowGeometry,
  origin: Point,
  pointer: Point,
  surface: WindowSurfaceSize,
  constraints: ClassicWindowConstraints,
): WindowGeometry => {
  const maximumWidth = Math.max(1, surface.width - original.x);
  const maximumHeight = Math.max(1, surface.height - original.y);
  const minimumWidth = Math.min(constraints.minWidth, maximumWidth);
  const minimumHeight = Math.min(constraints.minHeight, maximumHeight);

  return {
    ...original,
    width: clamp(Math.round(original.width + pointer.x - origin.x), minimumWidth, maximumWidth),
    height: clamp(Math.round(original.height + pointer.y - origin.y), minimumHeight, maximumHeight),
  };
};

export const committedWindowGeometry = (
  original: WindowGeometry,
  current: WindowGeometry,
  dragged: boolean,
  commit: boolean,
): WindowGeometry | null => {
  if (
    !commit ||
    !dragged ||
    (current.x === original.x &&
      current.y === original.y &&
      current.width === original.width &&
      current.height === original.height)
  ) {
    return null;
  }
  return current;
};

export const windowAnimationOffset = (geometry: WindowGeometry, origin: Point): Point => ({
  x: Math.round(origin.x - (geometry.x + geometry.width / 2)),
  y: Math.round(origin.y - (geometry.y + geometry.height / 2)),
});
