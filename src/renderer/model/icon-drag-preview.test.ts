import { describe, expect, it } from 'vitest';

import { createIconDragPreviewItems, resolveIconDragPreviewPosition } from './icon-drag-preview';

describe('icon drag preview', () => {
  it('preserves each selected icon offset from the grabbed pointer', () => {
    const items = createIconDragPreviewItems(
      [
        { nodeId: 'folder-a', bounds: { left: 40, top: 60, width: 32, height: 32 } },
        { nodeId: 'folder-b', bounds: { left: 120, top: 100, width: 32, height: 32 } },
      ],
      { x: 56, y: 76 },
    );

    expect(items).toEqual([
      {
        nodeId: 'folder-a',
        offsetFromPointer: { x: -16, y: -16 },
        size: 32,
      },
      {
        nodeId: 'folder-b',
        offsetFromPointer: { x: 64, y: 24 },
        size: 32,
      },
    ]);
    expect(resolveIconDragPreviewPosition(items[0], { x: 101, y: 119 })).toEqual({
      x: 85,
      y: 103,
    });
    expect(resolveIconDragPreviewPosition(items[1], { x: 101, y: 119 })).toEqual({
      x: 165,
      y: 143,
    });
  });

  it('ignores unusable source bounds', () => {
    expect(
      createIconDragPreviewItems(
        [
          { nodeId: 'missing', bounds: { left: 0, top: 0, width: 0, height: 32 } },
          {
            nodeId: 'invalid',
            bounds: { left: Number.NaN, top: 0, width: 32, height: 32 },
          },
        ],
        { x: 0, y: 0 },
      ),
    ).toEqual([]);
  });
});
