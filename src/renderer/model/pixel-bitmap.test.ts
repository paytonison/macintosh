import { describe, expect, it } from 'vitest';

import { ditherPixelSilhouette, rasterizeOneBitBitmap } from './pixel-bitmap';

describe('rasterizeOneBitBitmap', () => {
  it('turns authored gray pixels into a stable black-and-white checker', () => {
    expect(
      rasterizeOneBitBitmap({
        x: 1,
        y: 2,
        rows: ['gg', 'gg'],
      }),
    ).toEqual([
      { x: 1, y: 2, width: 1, color: 'white' },
      { x: 2, y: 2, width: 1, color: 'black' },
      { x: 1, y: 3, width: 1, color: 'black' },
      { x: 2, y: 3, width: 1, color: 'white' },
    ]);
  });

  it('emits only binary paint colors', () => {
    const runs = rasterizeOneBitBitmap({ x: 0, y: 0, rows: ['#g.g'] });

    expect(new Set(runs.map((run) => run.color))).toEqual(new Set(['black', 'white']));
  });

  it('turns painted icon pixels into an opaque aligned checker silhouette', () => {
    expect(
      ditherPixelSilhouette([
        { x: 1, y: 2, width: 3, color: 'white' },
        { x: 2, y: 3, width: 2, color: 'black' },
      ]),
    ).toEqual([
      { x: 1, y: 2, width: 1, color: 'white' },
      { x: 2, y: 2, width: 1, color: 'black' },
      { x: 3, y: 2, width: 1, color: 'white' },
      { x: 2, y: 3, width: 1, color: 'white' },
      { x: 3, y: 3, width: 1, color: 'black' },
    ]);
  });
});
