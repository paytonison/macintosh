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
        { id: 'system-disk', bounds: { left: 0, top: 0, right: 70, bottom: 70 } },
        { id: 'document-m2', bounds: { left: 100, top: 100, right: 182, bottom: 178 } },
        { id: 'folder-q7', bounds: { left: 230, top: 100, right: 312, bottom: 178 } },
      ]),
    ).toEqual(['document-m2']);
  });
});
