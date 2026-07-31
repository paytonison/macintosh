export type CursorBitmapName =
  'arrow' | 'pointing-hand' | 'open-hand' | 'closed-fist' | 'grab-open' | 'grab-closed' | 'resize';

interface CursorHotspot {
  x: number;
  y: number;
}

export interface CursorBitmap {
  cssVariable: string;
  width: number;
  height: number;
  hotspot: CursorHotspot;
  rows: readonly string[];
}

export interface CursorPixelRun {
  x: number;
  y: number;
  width: number;
  color: 'black' | 'white';
}

export const CURSOR_BITMAPS: Record<CursorBitmapName, CursorBitmap> = {
  arrow: {
    cssVariable: 'system-arrow-cursor',
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
    cssVariable: 'pointing-hand-cursor',
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
    cssVariable: 'open-hand-cursor',
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
    cssVariable: 'closed-fist-cursor',
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
  'grab-open': {
    cssVariable: 'grab-cursor',
    width: 16,
    height: 16,
    hotspot: { x: 7, y: 8 },
    rows: [
      '_____###________',
      '____#...#_______',
      '____#...####____',
      '____#...#...#___',
      '__###...#...###_',
      '_#...#..#..#..#_',
      '_#...#..#..#..#_',
      '_#.............#',
      '__#............#',
      '__#............#',
      '___#...........#',
      '___#..........#_',
      '____#........#__',
      '_____#......#___',
      '______######____',
      '________________',
    ],
  },
  'grab-closed': {
    cssVariable: 'grabbing-cursor',
    width: 16,
    height: 16,
    hotspot: { x: 7, y: 7 },
    rows: [
      '_____######_____',
      '___#........#___',
      '__#..##..##..#__',
      '_#..#..#..#...#_',
      '_#..#..#..#...#_',
      '_#............#_',
      '__#..........#__',
      '__#..........#__',
      '___#........#___',
      '___#........#___',
      '____#......#____',
      '_____######_____',
      '________________',
      '________________',
      '________________',
      '________________',
    ],
  },
  resize: {
    cssVariable: 'resize-cursor',
    width: 15,
    height: 15,
    hotspot: { x: 7, y: 7 },
    rows: [
      '######_________',
      '#....#_________',
      '#...#__________',
      '#..#___________',
      '#.#.#__________',
      '##__#.#________',
      '_____#.#_______',
      '______#.#______',
      '_______#.#_____',
      '________#.#___#',
      '_________#.#__#',
      '__________#.#_#',
      '___________#.##',
      '_________#....#',
      '_________######',
    ],
  },
};

export const rasterizeCursorBitmap = (bitmap: CursorBitmap): CursorPixelRun[] =>
  bitmap.rows.flatMap((row, y) => {
    const runs: CursorPixelRun[] = [];
    let x = 0;
    while (x < row.length) {
      const pixel = row[x];
      if (pixel !== '#' && pixel !== '.') {
        x += 1;
        continue;
      }

      let end = x + 1;
      while (end < row.length && row[end] === pixel) end += 1;
      runs.push({
        x,
        y,
        width: end - x,
        color: pixel === '#' ? 'black' : 'white',
      });
      x = end;
    }
    return runs;
  });

export const renderCursorSvg = (bitmap: CursorBitmap): string => {
  const rectangles = rasterizeCursorBitmap(bitmap).map(
    (run) =>
      `<rect x="${run.x}" y="${run.y}" width="${run.width}" height="1" fill="${run.color === 'black' ? '#000' : '#fff'}"/>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bitmap.width}" height="${bitmap.height}" viewBox="0 0 ${bitmap.width} ${bitmap.height}" shape-rendering="crispEdges">`,
    ...rectangles,
    '</svg>',
  ].join('');
};

export const cursorCssValue = (bitmap: CursorBitmap): string =>
  `url("data:image/svg+xml,${encodeURIComponent(renderCursorSvg(bitmap))}") ${bitmap.hotspot.x} ${bitmap.hotspot.y}`;

export const installPixelCursors = (style: Pick<CSSStyleDeclaration, 'setProperty'>): void => {
  for (const bitmap of Object.values(CURSOR_BITMAPS)) {
    style.setProperty(`--${bitmap.cssVariable}`, cursorCssValue(bitmap));
  }
};
