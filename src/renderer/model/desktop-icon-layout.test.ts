import { describe, expect, it } from 'vitest';

import { initialDesktopIconPosition } from '../../shared/desktop-icon-position';
import type { VfsNode } from '../../shared/state';
import { rectanglesOverlap, type Rectangle } from '../../shared/vfs';
import {
  cleanUpDesktopIconPositions,
  DESKTOP_ICON_HEIGHT,
  DESKTOP_ICON_WIDTH,
  desktopCleanupColumnX,
  desktopCleanupSpecialIconPositions,
  desktopIconIdsInRectangle,
  resolveDesktopIconPosition,
  translateDesktopIconDrag,
} from './desktop-icon-layout';

const desktopNode = (id: string, iconPosition?: { x: number; y: number }, name = id): VfsNode => ({
  id,
  parentId: 'desktop',
  name,
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

describe('Desktop cleanup layout', () => {
  it.each([
    [1152, 1070],
    [800, 718],
    [410, 328],
  ])('derives the rightmost cleanup-column origin for a %i-pixel surface', (width, expectedX) => {
    expect(desktopCleanupColumnX({ width, height: 746 })).toBe(expectedX);
  });

  it('derives the authored special-icon cleanup anchors from the live surface', () => {
    expect(desktopCleanupSpecialIconPositions({ width: 1152, height: 746 })).toEqual({
      diskPosition: { x: 1070, y: 7 },
      trashPosition: { x: 1070, y: 653 },
    });
    expect(desktopCleanupSpecialIconPositions({ width: 800, height: 538 })).toEqual({
      diskPosition: { x: 718, y: 7 },
      trashPosition: { x: 718, y: 445 },
    });
  });

  it('orders mixed-case names by stable identity and fills columns from the right edge', () => {
    const nodes = [
      desktopNode('tie-z', { x: 11, y: 12 }, 'alpha'),
      desktopNode('zulu', { x: 13, y: 14 }, 'Zulu'),
      desktopNode('tie-a', { x: 15, y: 16 }, 'Alpha'),
      desktopNode('beta', { x: 17, y: 18 }, 'beta'),
    ];
    const surface = { width: 164, height: 238 };
    const cleanupColumnX = desktopCleanupColumnX(surface);
    const expected = [
      { nodeId: 'tie-a', position: { x: cleanupColumnX, y: 77 } },
      { nodeId: 'tie-z', position: { x: cleanupColumnX, y: 160 } },
      { nodeId: 'beta', position: { x: 0, y: 77 } },
      { nodeId: 'zulu', position: { x: 0, y: 160 } },
    ];

    expect(cleanUpDesktopIconPositions(nodes, surface, [])).toEqual(expected);
    expect(cleanUpDesktopIconPositions([...nodes].reverse(), surface, [])).toEqual(expected);
  });

  it('matches the authored default-size right-column composition', () => {
    const surface = { width: 1152, height: 746 };
    const { trashPosition } = desktopCleanupSpecialIconPositions(surface);
    const reserved: Rectangle[] = [
      {
        left: trashPosition.x,
        top: trashPosition.y,
        right: trashPosition.x + DESKTOP_ICON_WIDTH,
        bottom: trashPosition.y + DESKTOP_ICON_HEIGHT,
      },
    ];

    expect(
      cleanUpDesktopIconPositions(
        [desktopNode('read-me'), desktopNode('untitled'), desktopNode('welcome')],
        surface,
        reserved,
      ),
    ).toEqual([
      { nodeId: 'read-me', position: { x: 1070, y: 77 } },
      { nodeId: 'untitled', position: { x: 1070, y: 160 } },
      { nodeId: 'welcome', position: { x: 1070, y: 243 } },
    ]);
  });

  it('places every item within bounds without ordinary or reserved-icon overlap', () => {
    const nodes = Array.from({ length: 6 }, (_, index) =>
      desktopNode(`item-${index}`, undefined, `Item ${index}`),
    );
    const surface = { width: 410, height: 326 };
    const { trashPosition } = desktopCleanupSpecialIconPositions(surface);
    const reserved: Rectangle[] = [
      {
        left: trashPosition.x,
        top: trashPosition.y,
        right: trashPosition.x + DESKTOP_ICON_WIDTH,
        bottom: trashPosition.y + DESKTOP_ICON_HEIGHT,
      },
    ];
    const placements = cleanUpDesktopIconPositions(nodes, surface, reserved);
    expect(placements).not.toBeNull();
    if (!placements) throw new Error('Expected every Desktop item to fit.');

    expect(placements).toHaveLength(nodes.length);
    expect(placements[0]).toEqual({ nodeId: 'item-0', position: { x: 328, y: 77 } });
    expect(placements[1]).toEqual({ nodeId: 'item-1', position: { x: 246, y: 77 } });

    const rectangles = placements.map(({ position }) => ({
      left: position.x,
      top: position.y,
      right: position.x + DESKTOP_ICON_WIDTH,
      bottom: position.y + DESKTOP_ICON_HEIGHT,
    }));
    for (const rectangle of rectangles) {
      expect(rectangle.left).toBeGreaterThanOrEqual(0);
      expect(rectangle.top).toBeGreaterThanOrEqual(0);
      expect(rectangle.right).toBeLessThanOrEqual(surface.width);
      expect(rectangle.bottom).toBeLessThanOrEqual(surface.height);
      expect(reserved.some((special) => rectanglesOverlap(rectangle, special))).toBe(false);
    }
    for (let left = 0; left < rectangles.length; left += 1) {
      for (let right = left + 1; right < rectangles.length; right += 1) {
        expect(rectanglesOverlap(rectangles[left]!, rectangles[right]!)).toBe(false);
      }
    }
  });

  it('returns null after exhausting the usable cells around the reserved Trash rectangle', () => {
    const surface = { width: 164, height: 238 };
    const { trashPosition } = desktopCleanupSpecialIconPositions(surface);
    const reserved: Rectangle[] = [
      {
        left: trashPosition.x,
        top: trashPosition.y,
        right: trashPosition.x + DESKTOP_ICON_WIDTH,
        bottom: trashPosition.y + DESKTOP_ICON_HEIGHT,
      },
    ];

    expect(
      cleanUpDesktopIconPositions([desktopNode('alpha'), desktopNode('beta')], surface, reserved),
    ).toEqual([
      { nodeId: 'alpha', position: { x: 0, y: 77 } },
      { nodeId: 'beta', position: { x: 0, y: 160 } },
    ]);
    expect(
      cleanUpDesktopIconPositions(
        [desktopNode('alpha'), desktopNode('beta'), desktopNode('gamma')],
        surface,
        reserved,
      ),
    ).toBeNull();
  });
});
