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

  it.each([
    {
      name: 'top-left',
      origin: { x: 100, y: 100 },
      expected: { x: 100, y: 100, width: 50, height: 36 },
      horizontalEdge: 'left' as const,
      verticalEdge: 'top' as const,
    },
    {
      name: 'top-right',
      origin: { x: 480, y: 100 },
      expected: { x: 430, y: 100, width: 50, height: 36 },
      horizontalEdge: 'right' as const,
      verticalEdge: 'top' as const,
    },
    {
      name: 'bottom-left',
      origin: { x: 100, y: 340 },
      expected: { x: 100, y: 304, width: 50, height: 36 },
      horizontalEdge: 'left' as const,
      verticalEdge: 'bottom' as const,
    },
    {
      name: 'bottom-right',
      origin: { x: 480, y: 340 },
      expected: { x: 430, y: 304, width: 50, height: 36 },
      horizontalEdge: 'right' as const,
      verticalEdge: 'bottom' as const,
    },
  ])(
    'anchors the $name start corner to an icon inside the final frame',
    ({ origin, expected, horizontalEdge, verticalEdge }) => {
      expect(windowAnimationStartGeometry(original, origin)).toEqual(expected);

      const frames = windowAnimationGeometryFrames(original, origin);
      expect(frames).toHaveLength(7);
      expect(frames[0]).toEqual(expected);
      expect(frames.at(-1)).toEqual(original);

      frames.forEach((frame, index) => {
        const progress = index / 6;
        const actualHorizontalEdge = horizontalEdge === 'left' ? frame.x : frame.x + frame.width;
        const finalHorizontalEdge =
          horizontalEdge === 'left' ? original.x : original.x + original.width;
        const actualVerticalEdge = verticalEdge === 'top' ? frame.y : frame.y + frame.height;
        const finalVerticalEdge =
          verticalEdge === 'top' ? original.y : original.y + original.height;

        expect(actualHorizontalEdge).toBe(
          Math.round(origin.x + (finalHorizontalEdge - origin.x) * progress),
        );
        expect(actualVerticalEdge).toBe(
          Math.round(origin.y + (finalVerticalEdge - origin.y) * progress),
        );
      });
    },
  );

  it('chooses left and top when an icon is equidistant from opposing edges', () => {
    expect(windowAnimationStartGeometry(original, { x: 290, y: 100 })).toEqual({
      x: 290,
      y: 100,
      width: 50,
      height: 36,
    });
    expect(windowAnimationStartGeometry(original, { x: 480, y: 214 })).toEqual({
      x: 430,
      y: 214,
      width: 50,
      height: 36,
    });
    expect(windowAnimationStartGeometry(original, { x: 290, y: 214 })).toEqual({
      x: 290,
      y: 214,
      width: 50,
      height: 36,
    });
  });

  it('uses the centered 12 percent start when no visible source icon exists', () => {
    expect(windowAnimationStartGeometry(original, null)).toEqual({
      x: 265,
      y: 196,
      width: 50,
      height: 36,
    });
    expect(windowAnimationGeometryFrames(original, null).at(-1)).toEqual(original);

    expect(windowAnimationStartGeometry({ x: 80, y: 64, width: 421, height: 301 }, null)).toEqual({
      x: 266,
      y: 197,
      width: 51,
      height: 36,
    });
  });

  it('interpolates rounded edges into positive integer frames and exact final geometry', () => {
    const origin = { x: 617, y: 443 };
    const frames = windowAnimationGeometryFrames(original, origin);
    const start = { x: 567, y: 407, width: 50, height: 36 };

    expect(frames).toHaveLength(7);
    expect(frames[0]).toEqual(start);

    frames.forEach((frame, index) => {
      const progress = index / 6;
      const expectedLeft = Math.round(start.x + (original.x - start.x) * progress);
      const expectedRight = Math.round(
        start.x + start.width + (original.x + original.width - (start.x + start.width)) * progress,
      );
      const expectedTop = Math.round(start.y + (original.y - start.y) * progress);
      const expectedBottom = Math.round(
        start.y +
          start.height +
          (original.y + original.height - (start.y + start.height)) * progress,
      );

      expect(frame).toEqual({
        x: expectedLeft,
        y: expectedTop,
        width: expectedRight - expectedLeft,
        height: expectedBottom - expectedTop,
      });
      expect(Object.values(frame).every(Number.isInteger)).toBe(true);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);
    });

    expect(frames.at(-1)).toEqual(original);
  });
});
