import { describe, expect, it } from 'vitest';

import {
  defaultFinderIconPosition,
  finderIconCanvasSize,
  resolveFinderIconPositions,
  translateFinderIconDrag,
} from './finder-icon-layout';
import type { VfsNode } from '../../shared/state';

const finderNode = (id: string, iconPosition?: { x: number; y: number }): VfsNode => ({
  id,
  parentId: 'system-disk',
  name: id,
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
