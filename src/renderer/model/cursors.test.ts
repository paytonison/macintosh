import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import importedMacintoshCss from '../styles/macintosh.css?raw';
import {
  CURSOR_BITMAPS,
  cursorCssValue,
  installPixelCursors,
  rasterizeCursorBitmap,
  renderCursorSvg,
} from './cursors';

const EXPECTED_SYSTEM_ITEM_CURSOR_ROWS = {
  arrow: [
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
  'pointing-hand': [
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
  'open-hand': [
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
  'closed-fist': [
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
} as const;

const macintoshCss =
  importedMacintoshCss ||
  readFileSync(new URL('../styles/macintosh.css', import.meta.url), { encoding: 'utf8' });

const cssRules = [...macintoshCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
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

describe('pixel cursor assets', () => {
  it('locks the authored System 1 item cursor artwork row by row', () => {
    expect({
      arrow: CURSOR_BITMAPS.arrow.rows,
      'pointing-hand': CURSOR_BITMAPS['pointing-hand'].rows,
      'open-hand': CURSOR_BITMAPS['open-hand'].rows,
      'closed-fist': CURSOR_BITMAPS['closed-fist'].rows,
    }).toEqual(EXPECTED_SYSTEM_ITEM_CURSOR_ROWS);
  });

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
      'pointing-hand': { width: 16, height: 16, hotspot: { x: 5, y: 1 } },
      'open-hand': { width: 16, height: 16, hotspot: { x: 8, y: 8 } },
      'closed-fist': { width: 16, height: 16, hotspot: { x: 8, y: 8 } },
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

  it('keeps each System 1 item pointer white-filled with a black outline', () => {
    const neighbors = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const;

    for (const name of ['arrow', 'pointing-hand', 'open-hand', 'closed-fist'] as const) {
      const bitmap = CURSOR_BITMAPS[name];
      expect(new Set(bitmap.rows.join('').replaceAll('_', ''))).toEqual(new Set(['#', '.']));
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
          if (exposed) expect(pixel, `${name} exposed pixel at ${x},${y}`).toBe('#');
        }
      }
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

describe('pixel cursor stylesheet bindings', () => {
  it('uses the authored System arrow for normal surfaces and controls', () => {
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

  it('uses pointing, open, and closed hands for complete item sessions', () => {
    for (const selector of ['.desktop-icon', '.finder-item', '.finder-list-row']) {
      expect(cursorDeclaration(selector)).toContain('var(--pointing-hand-cursor)');
    }
    for (const selector of [
      '.desktop-icon.is-pointer-pressed',
      '.finder-item.is-pointer-pressed',
      '.finder-list-row.is-pointer-pressed',
    ]) {
      expect(cursorDeclaration(selector)).toContain('var(--open-hand-cursor)');
    }
    expect(cursorDeclaration('.desktop-icon.is-dragging')).toContain('var(--closed-fist-cursor)');
    for (const selector of [
      'html.is-item-dragging',
      'html.is-item-dragging *',
      '.macintosh.is-item-dragging',
      '.macintosh.is-item-dragging *',
    ]) {
      expect(cursorDeclaration(selector)).toBe('var(--closed-fist-cursor), default !important');
    }
  });

  it('preserves the pixel-authored window move and resize cursors from main', () => {
    expect(cursorDeclaration('.window-titlebar')).toBe('var(--grab-cursor), grab');
    expect(cursorDeclaration('.dialog-titlebar')).toBe('var(--grab-cursor), grab');
    expect(cursorDeclaration('.finder-window.is-shadow-dragging .window-titlebar')).toBe(
      'var(--grabbing-cursor), grabbing',
    );
    expect(cursorDeclaration('.calculator-titlebar')).toBe('var(--grab-cursor), grab');
    expect(cursorDeclaration('.window-grow-box')).toBe('var(--resize-cursor), nwse-resize');
  });
});
