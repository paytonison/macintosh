import { describe, expect, it } from 'vitest';

import {
  cleanUpFinderIconPositions,
  defaultFinderIconPosition,
  finderIconCanvasSize,
  resolveFinderIconPositions,
  translateFinderIconDrag,
} from './finder-icon-layout';
import type { VfsNode } from '../../shared/state';

const finderNode = (id: string, iconPosition?: { x: number; y: number }, name = id): VfsNode => ({
  id,
  parentId: 'system-disk',
  name,
  kind: 'folder',
  ...(iconPosition ? { iconPosition } : {}),
  createdAt: '1989-01-24T09:00:00.000Z',
  modifiedAt: '1989-01-24T09:00:00.000Z',
});

describe('Finder free icon layout', () => {
  it('provides orderly initial slots without quantizing committed coordinates', () => {
    expect(defaultFinderIconPosition(0)).toEqual({ x: 24, y: 28 });
    expect(defaultFinderIconPosition(4)).toEqual({ x: 24, y: 142 });
    expect(
      finderIconCanvasSize([
        { x: 173, y: 119 },
        { x: 777, y: 333 },
      ]),
    ).toEqual({ width: 931, height: 463 });
  });

  it('assigns missing initial slots by stable identity rather than storage order', () => {
    const first = finderNode('folder-z');
    const second = finderNode('folder-a');
    const positioned = resolveFinderIconPositions([first, second]);
    const reordered = resolveFinderIconPositions([second, first]);

    expect(positioned.get('folder-a')).toEqual(defaultFinderIconPosition(0));
    expect(positioned.get('folder-z')).toEqual(defaultFinderIconPosition(1));
    expect(reordered).toEqual(positioned);
  });

  it('moves a selected group by one free delta while preserving its shape', () => {
    const translated = translateFinderIconDrag(
      {
        anchorId: 'applications',
        pointerOffset: { x: 31, y: 19 },
        positions: {
          applications: { x: 24, y: 28 },
          documents: { x: 168, y: 28 },
        },
      },
      { x: 204, y: 138 },
    );

    expect(translated).toEqual({
      applications: { x: 173, y: 119 },
      documents: { x: 317, y: 119 },
    });
  });

  it('keeps a group together when its translated edge would cross the canvas origin', () => {
    const translated = translateFinderIconDrag(
      {
        anchorId: 'documents',
        pointerOffset: { x: 40, y: 40 },
        positions: {
          applications: { x: 24, y: 28 },
          documents: { x: 168, y: 28 },
        },
      },
      { x: 20, y: 20 },
    );

    expect(translated.applications).toEqual({ x: 0, y: 0 });
    expect(translated.documents).toEqual({ x: 144, y: 0 });
  });

  it('keeps a group together at the bounded far edge', () => {
    const translated = translateFinderIconDrag(
      {
        anchorId: 'applications',
        pointerOffset: { x: 0, y: 0 },
        positions: {
          applications: { x: 24, y: 28 },
          documents: { x: 168, y: 142 },
        },
      },
      { x: 8180, y: 8180 },
    );

    expect(translated.applications).toEqual({ x: 8048, y: 8078 });
    expect(translated.documents).toEqual({ x: 8192, y: 8192 });
  });
});

describe('Finder cleanup layout', () => {
  it('replaces saved positions with stable alphabetical Finder slots', () => {
    const nodes = [
      finderNode('tie-z', { x: 700, y: 701 }, 'alpha'),
      finderNode('zulu', { x: 702, y: 703 }, 'Zulu'),
      finderNode('tie-a', { x: 704, y: 705 }, 'Alpha'),
      finderNode('charlie', { x: 706, y: 707 }, 'charlie'),
      finderNode('beta', { x: 708, y: 709 }, 'beta'),
    ];
    const expected = [
      { nodeId: 'tie-a', position: defaultFinderIconPosition(0) },
      { nodeId: 'tie-z', position: defaultFinderIconPosition(1) },
      { nodeId: 'beta', position: defaultFinderIconPosition(2) },
      { nodeId: 'charlie', position: defaultFinderIconPosition(3) },
      { nodeId: 'zulu', position: defaultFinderIconPosition(4) },
    ];

    expect(cleanUpFinderIconPositions(nodes)).toEqual(expected);
    expect(cleanUpFinderIconPositions([...nodes].reverse())).toEqual(expected);
    expect(expected[0]?.position).toEqual({ x: 24, y: 28 });
    expect(expected[4]?.position).toEqual({ x: 24, y: 142 });
  });

  it('continues into another horizontal band before persisted positions can overlap', () => {
    const nodes = Array.from({ length: 300 }, (_, index) =>
      finderNode(`item-${index.toString().padStart(3, '0')}`),
    );
    const placements = cleanUpFinderIconPositions(nodes);
    const coordinateKeys = placements.map(
      ({ position }) => `${position.x.toString()},${position.y.toString()}`,
    );

    expect(placements[287]?.position).toEqual({ x: 456, y: 8122 });
    expect(placements[288]?.position).toEqual({ x: 600, y: 28 });
    expect(placements[292]?.position).toEqual({ x: 600, y: 142 });
    expect(new Set(coordinateKeys).size).toBe(nodes.length);
    expect(
      placements.every(
        ({ position }) =>
          position.x >= 0 && position.x <= 8192 && position.y >= 0 && position.y <= 8192,
      ),
    ).toBe(true);
  });
});
