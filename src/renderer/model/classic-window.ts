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

const WINDOW_ANIMATION_START_SCALE = 0.12;
const WINDOW_ANIMATION_STEPS = 6;

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
  const maximumWidth = Math.max(constraints.minWidth, surface.width - original.x);
  const maximumHeight = Math.max(constraints.minHeight, surface.height - original.y);

  return {
    ...original,
    width: clamp(
      Math.round(original.width + pointer.x - origin.x),
      constraints.minWidth,
      maximumWidth,
    ),
    height: clamp(
      Math.round(original.height + pointer.y - origin.y),
      constraints.minHeight,
      maximumHeight,
    ),
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

export const windowAnimationStartGeometry = (
  geometry: WindowGeometry,
  origin: Point,
): WindowGeometry => {
  const width = Math.max(1, Math.round(geometry.width * WINDOW_ANIMATION_START_SCALE));
  const height = Math.max(1, Math.round(geometry.height * WINDOW_ANIMATION_START_SCALE));

  return {
    x: Math.round(origin.x - width / 2),
    y: Math.round(origin.y - height / 2),
    width,
    height,
  };
};

export const windowAnimationGeometryFrames = (
  geometry: WindowGeometry,
  origin: Point,
): WindowGeometry[] => {
  const start = windowAnimationStartGeometry(geometry, origin);
  return Array.from({ length: WINDOW_ANIMATION_STEPS + 1 }, (_, index) => {
    const progress = index / WINDOW_ANIMATION_STEPS;
    return {
      x: Math.round(start.x + (geometry.x - start.x) * progress),
      y: Math.round(start.y + (geometry.y - start.y) * progress),
      width: Math.round(start.width + (geometry.width - start.width) * progress),
      height: Math.round(start.height + (geometry.height - start.height) * progress),
    };
  });
};
