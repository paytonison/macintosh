export interface PixelBitmap {
  x: number;
  y: number;
  rows: string[];
}

export interface PixelRun {
  x: number;
  y: number;
  width: number;
  color: 'black' | 'white';
}

const resolvePixelColor = (pixel: string, x: number, y: number): PixelRun['color'] | null => {
  if (pixel === '#') return 'black';
  if (pixel === '.') return 'white';
  if (pixel === 'g') return (x + y) % 2 === 0 ? 'black' : 'white';
  return null;
};

export const rasterizeOneBitBitmap = ({ x, y, rows }: PixelBitmap): PixelRun[] =>
  rows.flatMap((row, rowIndex) => {
    const runs: PixelRun[] = [];
    let start = 0;
    while (start < row.length) {
      const color = resolvePixelColor(row[start], x + start, y + rowIndex);
      if (!color) {
        start += 1;
        continue;
      }

      let end = start + 1;
      while (end < row.length && resolvePixelColor(row[end], x + end, y + rowIndex) === color) {
        end += 1;
      }

      runs.push({
        x: x + start,
        y: y + rowIndex,
        width: end - start,
        color,
      });
      start = end;
    }
    return runs;
  });
