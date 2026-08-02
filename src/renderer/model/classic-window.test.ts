import { describe, expect, it } from 'vitest';

import type { WindowGeometry } from '../../shared/state';
import {
  committedWindowGeometry,
  previewWindowMove,
  previewWindowResize,
  windowAnimationGeometryFrames,
  windowAnimationStartGeometry,
} from './classic-window';

const original: WindowGeometry = { x: 80, y: 64, width: 420, height: 300 };
const surface = { width: 800, height: 600 };
const constraints = { minWidth: 300, minHeight: 220 };

describe('classic window geometry', () => {
  it('previews a move from the committed rectangle and retains a recoverable title bar', () => {
    expect(
      previewWindowMove(original, { x: 100, y: 90 }, { x: 148, y: 122 }, surface, constraints),
    ).toEqual({
      ...original,
      x: 128,
      y: 96,
    });
    expect(
      previewWindowMove(original, { x: 100, y: 90 }, { x: -500, y: -500 }, surface, constraints),
    ).toEqual({
      ...original,
      x: 0,
      y: 0,
    });
    expect(
      previewWindowMove(original, { x: 100, y: 90 }, { x: 2_000, y: 2_000 }, surface, constraints),
    ).toEqual({
      ...original,
      x: 704,
      y: 572,
    });
  });

  it('previews resize within the application surface and component minimums', () => {
    expect(
      previewWindowResize(original, { x: 500, y: 364 }, { x: 560, y: 414 }, surface, constraints),
    ).toEqual({
      ...original,
      width: 480,
      height: 350,
    });
    expect(
      previewWindowResize(original, { x: 500, y: 364 }, { x: 0, y: 0 }, surface, constraints),
    ).toEqual({
      ...original,
      width: 300,
      height: 220,
    });
    expect(
      previewWindowResize(
        original,
        { x: 500, y: 364 },
        { x: 2_000, y: 2_000 },
        surface,
        constraints,
      ),
    ).toEqual({
      ...original,
      width: 720,
      height: 536,
    });

    const writeWindow = { x: 220, y: 140, width: 560, height: 400 };
    expect(
      previewWindowResize(writeWindow, { x: 780, y: 540 }, { x: 0, y: 0 }, surface, {
        minWidth: 520,
        minHeight: 360,
      }),
    ).toEqual({ ...writeWindow, width: 520, height: 360 });
    expect(
      previewWindowResize(writeWindow, { x: 780, y: 540 }, { x: 2_000, y: 2_000 }, surface, {
        minWidth: 520,
        minHeight: 360,
      }),
    ).toEqual({ ...writeWindow, width: 580, height: 460 });

    const partiallyOffscreen = { x: 760, y: 580, width: 300, height: 220 };
    expect(
      previewWindowResize(
        partiallyOffscreen,
        { x: 1_060, y: 800 },
        { x: 0, y: 0 },
        surface,
        constraints,
      ),
    ).toEqual(partiallyOffscreen);
  });

  it('keeps preview geometry out of committed state until a changed drag is released', () => {
    const preview = { ...original, width: 536, height: 382 };

    expect(committedWindowGeometry(original, preview, true, false)).toBeNull();
    expect(committedWindowGeometry(original, preview, false, true)).toBeNull();
    expect(committedWindowGeometry(original, original, true, true)).toBeNull();
    expect(committedWindowGeometry(original, preview, true, true)).toEqual(preview);
  });

  it('computes a small integer animation frame centered on the source point', () => {
    expect(windowAnimationStartGeometry(original, { x: 92, y: 78 })).toEqual({
      x: 67,
      y: 60,
      width: 50,
      height: 36,
    });

    const frames = windowAnimationGeometryFrames(original, { x: 92, y: 78 });
    expect(frames).toHaveLength(7);
    expect(frames[0]).toEqual({ x: 67, y: 60, width: 50, height: 36 });
    expect(frames.at(-1)).toEqual(original);
    expect(
      frames.every((frame) =>
        Object.values(frame).every((coordinate) => Number.isInteger(coordinate)),
      ),
    ).toBe(true);
  });
});
