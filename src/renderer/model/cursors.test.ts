import { describe, expect, it, vi } from 'vitest';

import {
  CURSOR_BITMAPS,
  cursorCssValue,
  installPixelCursors,
  rasterizeCursorBitmap,
  renderCursorSvg,
} from './cursors';

describe('pixel cursor assets', () => {
  it('locks every intrinsic size and hotspot to an integer pixel', () => {
    expect(
      Object.fromEntries(
        Object.entries(CURSOR_BITMAPS).map(([name, bitmap]) => [
          name,
          { width: bitmap.width, height: bitmap.height, hotspot: bitmap.hotspot },
        ]),
      ),
    ).toEqual({
      arrow: { width: 11, height: 16, hotspot: { x: 1, y: 1 } },
      'grab-open': { width: 16, height: 16, hotspot: { x: 7, y: 8 } },
      'grab-closed': { width: 16, height: 16, hotspot: { x: 7, y: 7 } },
      resize: { width: 15, height: 15, hotspot: { x: 7, y: 7 } },
    });

    for (const bitmap of Object.values(CURSOR_BITMAPS)) {
      expect(bitmap.rows).toHaveLength(bitmap.height);
      expect(bitmap.rows.every((row) => row.length === bitmap.width)).toBe(true);
      expect(bitmap.rows.every((row) => /^[#._]+$/.test(row))).toBe(true);
      expect(bitmap.rows.some((row) => row.includes('_'))).toBe(true);
      expect(Number.isInteger(bitmap.hotspot.x)).toBe(true);
      expect(Number.isInteger(bitmap.hotspot.y)).toBe(true);
      expect(bitmap.hotspot.x).toBeGreaterThanOrEqual(0);
      expect(bitmap.hotspot.x).toBeLessThan(bitmap.width);
      expect(bitmap.hotspot.y).toBeGreaterThanOrEqual(0);
      expect(bitmap.hotspot.y).toBeLessThan(bitmap.height);
    }
  });

  it('serializes only black-and-white integer-aligned rectangles', () => {
    for (const bitmap of Object.values(CURSOR_BITMAPS)) {
      const svg = renderCursorSvg(bitmap);
      const runs = rasterizeCursorBitmap(bitmap);

      expect(svg).toContain(`width="${bitmap.width}" height="${bitmap.height}"`);
      expect(svg).toContain(`viewBox="0 0 ${bitmap.width} ${bitmap.height}"`);
      expect(svg).toContain('shape-rendering="crispEdges"');
      expect(svg.match(/<rect /g)).toHaveLength(runs.length);
      expect(new Set([...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]))).toEqual(
        new Set(['#000', '#fff']),
      );
      expect(svg).not.toMatch(/<path\b|\bstroke(?:-|=)|\btransform=/);
      expect(
        runs.every((run) => [run.x, run.y, run.width].every((value) => Number.isInteger(value))),
      ).toBe(true);
    }
  });

  it('installs the matching data assets and hotspots as cursor properties', () => {
    const setProperty = vi.fn();
    installPixelCursors({ setProperty });

    expect(setProperty).toHaveBeenCalledTimes(Object.keys(CURSOR_BITMAPS).length);
    for (const bitmap of Object.values(CURSOR_BITMAPS)) {
      const value = cursorCssValue(bitmap);
      expect(setProperty).toHaveBeenCalledWith(`--${bitmap.cssVariable}`, value);
      expect(value.endsWith(` ${bitmap.hotspot.x} ${bitmap.hotspot.y}`)).toBe(true);
      expect(decodeURIComponent(value)).toContain(renderCursorSvg(bitmap));
    }
  });
});
