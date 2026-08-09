import { describe, expect, it } from 'vitest';

import { initialDesktopIconPosition } from '../../shared/desktop-icon-position';
import type { VfsNode } from '../../shared/state';
import {
  desktopIconIdsInRectangle,
  resolveDesktopIconPosition,
  translateDesktopIconDrag,
} from './desktop-icon-layout';

const desktopNode = (id: string, iconPosition?: { x: number; y: number }): VfsNode => ({
  id,
  parentId: 'desktop',
  name: id,
  kind: 'document',
  ...(iconPosition ? { iconPosition } : {}),
  createdAt: '1989-01-24T09:00:00.000Z',
  modifiedAt: '1989-01-24T09:00:00.000Z',
});

describe('Desktop free icon layout', () => {
  it('resolves a missing position from stable node identity and preserves a saved position', () => {
    expect(resolveDesktopIconPosition(desktopNode('document-m2'))).toEqual(
      initialDesktopIconPosition('document-m2'),
    );
    expect(resolveDesktopIconPosition(desktopNode('document-m2', { x: 173, y: 119 }))).toEqual({
      x: 173,
      y: 119,
    });
  });

  it('moves a selected group by one free delta while preserving its relative arrangement', () => {
    const translated = translateDesktopIconDrag(
      {
        anchorId: 'first',
        pointerOffset: { x: 17, y: 13 },
        positions: {
          first: { x: 121, y: 93 },
          second: { x: 274, y: 167 },
        },
      },
      { x: 440, y: 311 },
      { width: 800, height: 538 },
    );

    expect(translated).toEqual({
      first: { x: 423, y: 298 },
      second: { x: 576, y: 372 },
    });
  });

  it('clamps the whole group against the rendered desktop footprint', () => {
    const translated = translateDesktopIconDrag(
      {
        anchorId: 'first',
        pointerOffset: { x: 0, y: 0 },
        positions: {
          first: { x: 20, y: 20 },
          second: { x: 120, y: 70 },
        },
      },
      { x: 790, y: 530 },
      { width: 800, height: 538 },
    );

    expect(translated).toEqual({
      first: { x: 618, y: 410 },
      second: { x: 718, y: 460 },
    });
  });

  it.each([
    ['horizontal', { first: { x: 0, y: 20 }, second: { x: 719, y: 20 } }],
    ['vertical', { first: { x: 20, y: 0 }, second: { x: 20, y: 461 } }],
  ])('refuses an oversized %s group that cannot fit the desktop', (_axis, positions) => {
    expect(
      translateDesktopIconDrag(
        {
          anchorId: 'first',
          pointerOffset: { x: 0, y: 0 },
          positions,
        },
        { x: 100, y: 100 },
        { width: 800, height: 538 },
      ),
    ).toBeNull();
  });

  it('allows a group whose span exactly fits the usable desktop bounds', () => {
    expect(
      translateDesktopIconDrag(
        {
          anchorId: 'first',
          pointerOffset: { x: 0, y: 0 },
          positions: {
            first: { x: 0, y: 0 },
            second: { x: 718, y: 460 },
          },
        },
        { x: 100, y: 100 },
        { width: 800, height: 538 },
      ),
    ).toEqual({
      first: { x: 0, y: 0 },
      second: { x: 718, y: 460 },
    });
  });

  it('returns arbitrary stable desktop node IDs from marquee overlap', () => {
    expect(
      desktopIconIdsInRectangle({ left: 90, top: 90, right: 220, bottom: 180 }, [
        {
          id: 'system-disk',
          hitRegions: [{ left: 18, top: 2, right: 62, bottom: 61 }],
        },
        {
          id: 'document-m2',
          hitRegions: [
            { left: 119, top: 102, right: 163, bottom: 144 },
            { left: 105, top: 144, right: 177, bottom: 161 },
          ],
        },
        {
          id: 'folder-q7',
          hitRegions: [{ left: 249, top: 102, right: 293, bottom: 161 }],
        },
      ]),
    ).toEqual(['document-m2']);
  });

  it('ignores transparent layout-tile margins and gaps between visible hit regions', () => {
    const icon = {
      id: 'document-m2',
      hitRegions: [
        { left: 119, top: 102, right: 163, bottom: 134 },
        { left: 105, top: 144, right: 177, bottom: 161 },
      ],
    };

    expect(
      desktopIconIdsInRectangle({ left: 100, top: 170, right: 182, bottom: 178 }, [icon]),
    ).toEqual([]);
    expect(
      desktopIconIdsInRectangle({ left: 120, top: 136, right: 162, bottom: 142 }, [icon]),
    ).toEqual([]);
    expect(
      desktopIconIdsInRectangle({ left: 120, top: 120, right: 121, bottom: 121 }, [icon]),
    ).toEqual(['document-m2']);
  });
});
