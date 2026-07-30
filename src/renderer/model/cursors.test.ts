import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import importedMacintoshCss from '../styles/macintosh.css?raw';
import {
  CURSOR_BITMAPS,
  cursorCssValue,
  installMacintoshCursors,
  rasterizeCursorBitmap,
  renderCursorSvg,
} from './cursors';

const EXPECTED_CURSOR_BITMAPS = {
  arrow: {
    cssVariable: '--system-arrow-cursor',
    width: 11,
    height: 16,
    hotspot: { x: 1, y: 1 },
    rows: [
      '##_________',
      '#.#________',
      '#..#_______',
      '#...#______',
      '#....#_____',
      '#.....#____',
      '#......#___',
      '#.......#__',
      '#........#_',
      '#.....#####',
      '#..#..#____',
      '#.#_#..#___',
      '##__#..#___',
      '#____#..#__',
      '_____#..#__',
      '______###__',
    ],
  },
  'pointing-hand': {
    cssVariable: '--pointing-hand-cursor',
    width: 16,
    height: 16,
    hotspot: { x: 5, y: 1 },
    rows: [
      '_____##_________',
      '____#..#________',
      '____#..#________',
      '____#..#________',
      '____#..###______',
      '____#..#..###___',
      '__###..#..#..#__',
      '_#..#..#..#..#__',
      '__#...........#_',
      '__#...........#_',
      '_#............#_',
      '__#...........#_',
      '___#.........#__',
      '___#.........#__',
      '____#.......#___',
      '_____#######____',
    ],
  },
  'open-hand': {
    cssVariable: '--open-hand-cursor',
    width: 16,
    height: 16,
    hotspot: { x: 8, y: 8 },
    rows: [
      '_______##_______',
      '______#..###____',
      '____###..#..#___',
      '___#..#..#..###_',
      '___#..#..#..#..#',
      '___#..#..#..#..#',
      '_###..#..#..#..#',
      '#..#..#..#..#..#',
      '_#.............#',
      '#..............#',
      '#..............#',
      '_#............#_',
      '__#..........#__',
      '___#........#___',
      '____#......#____',
      '_____######_____',
    ],
  },
  'closed-fist': {
    cssVariable: '--closed-fist-cursor',
    width: 16,
    height: 16,
    hotspot: { x: 8, y: 8 },
    rows: [
      '________________',
      '___##_##_##_##__',
      '__#..#..#..#..#_',
      '_#.............#',
      '_#.............#',
      '#..............#',
      '#..............#',
      '#..............#',
      '#..............#',
      '#..............#',
      '_#............#_',
      '_#...........#__',
      '__#..........#__',
      '___#........#___',
      '____#......#____',
      '_____######_____',
    ],
  },
} as const;

const macintoshCss =
  importedMacintoshCss ||
  readFileSync(new URL('../styles/macintosh.css', import.meta.url), { encoding: 'utf8' });

interface CssRule {
  selectors: string[];
  declarations: string;
}

const cssRules: CssRule[] = [...macintoshCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selectorList, declarations]) => ({
    selectors: selectorList.split(',').map((selector) => selector.trim()),
    declarations,
  }),
);

const cursorDeclaration = (selector: string): string => {
  const rule = cssRules.find(
    (candidate) =>
      candidate.selectors.includes(selector) && /cursor\s*:/.test(candidate.declarations),
  );
  expect(rule, `Missing cursor rule for ${selector}`).toBeDefined();
  const declaration = rule?.declarations.match(/cursor:\s*([^;]+);/)?.[1]?.trim();
  expect(declaration, `Missing cursor declaration for ${selector}`).toBeDefined();
  return declaration ?? '';
};

describe('System 1 cursor bitmap assets', () => {
  it('locks every bitmap row, size, CSS variable, and hotspot exactly', () => {
    expect(CURSOR_BITMAPS).toEqual(EXPECTED_CURSOR_BITMAPS);

    for (const bitmap of Object.values(CURSOR_BITMAPS)) {
      expect(bitmap.rows).toHaveLength(bitmap.height);
      expect(bitmap.rows.every((row) => row.length === bitmap.width)).toBe(true);
      expect(bitmap.rows.every((row) => /^[#._]+$/.test(row))).toBe(true);
      expect(Number.isInteger(bitmap.hotspot.x)).toBe(true);
      expect(Number.isInteger(bitmap.hotspot.y)).toBe(true);
      expect(bitmap.hotspot.x).toBeGreaterThanOrEqual(0);
      expect(bitmap.hotspot.x).toBeLessThan(bitmap.width);
      expect(bitmap.hotspot.y).toBeGreaterThanOrEqual(0);
      expect(bitmap.hotspot.y).toBeLessThan(bitmap.height);
    }
  });

  it('keeps white interiors enclosed by black outlines', () => {
    const neighbors = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;

    for (const bitmap of Object.values(CURSOR_BITMAPS)) {
      const colors = new Set(bitmap.rows.join('').replaceAll('_', ''));
      expect(colors).toEqual(new Set(['#', '.']));
      for (const [y, row] of bitmap.rows.entries()) {
        for (const [x, pixel] of [...row].entries()) {
          if (pixel === '_') continue;
          const exposed = neighbors.some(([offsetX, offsetY]) => {
            const neighborRow = bitmap.rows[y + offsetY];
            return (
              !neighborRow ||
              neighborRow[x + offsetX] === undefined ||
              neighborRow[x + offsetX] === '_'
            );
          });
          if (exposed) expect(pixel, `${bitmap.cssVariable} exposed pixel at ${x},${y}`).toBe('#');
        }
      }
    }
  });

  it('serializes only crisp, integer-aligned black-and-white rectangles', () => {
    for (const bitmap of Object.values(CURSOR_BITMAPS)) {
      const svg = renderCursorSvg(bitmap);
      const runs = rasterizeCursorBitmap(bitmap);

      expect(svg).toContain(`width="${bitmap.width}" height="${bitmap.height}"`);
      expect(svg).toContain(`viewBox="0 0 ${bitmap.width} ${bitmap.height}"`);
      expect(svg).toContain('shape-rendering="crispEdges"');
      expect(svg.match(/<rect /g)).toHaveLength(runs.length);
      expect(svg).not.toMatch(/<(?:path|circle|ellipse|line|polyline|polygon|g)\b/);
      expect(svg).not.toMatch(/\bstroke(?:-|=)|\btransform=|\bopacity=/);
      expect(new Set([...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]))).toEqual(
        new Set(['#000', '#fff']),
      );
      expect(
        runs.every((run) =>
          [run.x, run.y, run.width].every((coordinate) => Number.isInteger(coordinate)),
        ),
      ).toBe(true);
    }
  });

  it('installs each serialized cursor with its exact hotspot', () => {
    const setProperty = vi.fn();
    installMacintoshCursors({ setProperty });

    expect(setProperty).toHaveBeenCalledTimes(Object.keys(CURSOR_BITMAPS).length);
    for (const bitmap of Object.values(CURSOR_BITMAPS)) {
      const value = cursorCssValue(bitmap);
      expect(setProperty).toHaveBeenCalledWith(bitmap.cssVariable, value);
      expect(value.endsWith(` ${bitmap.hotspot.x} ${bitmap.hotspot.y}`)).toBe(true);
      expect(decodeURIComponent(value)).toContain(renderCursorSvg(bitmap));
    }
  });
});

describe('System 1 cursor stylesheet bindings', () => {
  it('uses the authored arrow for normal surfaces and controls', () => {
    for (const selector of [
      'body',
      'button',
      '.window-titlebar > button',
      '.dialog-titlebar > button',
      '.calculator-titlebar > button',
    ]) {
      expect(cursorDeclaration(selector)).toContain('var(--system-arrow-cursor)');
    }
  });

  it('uses the pointing hand across complete desktop and Finder item regions', () => {
    for (const selector of ['.desktop-icon', '.finder-item', '.finder-list-row']) {
      expect(cursorDeclaration(selector)).toContain('var(--pointing-hand-cursor)');
    }
  });

  it('uses the open hand only while an item press remains below its drag threshold', () => {
    for (const selector of [
      '.desktop-icon.is-pointer-pressed',
      '.finder-item.is-pointer-pressed',
      '.finder-list-row.is-pointer-pressed',
    ]) {
      expect(cursorDeclaration(selector)).toContain('var(--open-hand-cursor)');
    }
  });

  it('keeps the closed fist active on the source and across the full drag surface', () => {
    expect(cursorDeclaration('.desktop-icon.is-dragging')).toBe(
      'var(--closed-fist-cursor), default',
    );
    for (const selector of [
      'html.is-item-dragging',
      'html.is-item-dragging *',
      '.macintosh.is-item-dragging',
      '.macintosh.is-item-dragging *',
    ]) {
      expect(cursorDeclaration(selector)).toBe('var(--closed-fist-cursor), default !important');
    }
  });

  it('preserves the existing window-move and resize cursors', () => {
    expect(cursorDeclaration('.window-titlebar')).toBe('grab');
    expect(cursorDeclaration('.dialog-titlebar')).toBe('grab');
    expect(cursorDeclaration('.finder-window.is-shadow-dragging .window-titlebar')).toBe(
      'grabbing',
    );
    expect(cursorDeclaration('.calculator-titlebar')).toBe('grab');
    expect(cursorDeclaration('.calculator-window.is-dragging .calculator-titlebar')).toBe(
      'grabbing',
    );
    expect(cursorDeclaration('.window-grow-box')).toBe('nwse-resize');
  });
});
