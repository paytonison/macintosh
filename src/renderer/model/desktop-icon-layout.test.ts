import { describe, expect, it } from 'vitest';

import {
  desktopIconIdsInRectangle,
  placeImportedDesktopRoots,
  translateDesktopIconDrag,
} from './desktop-icon-layout';

describe('Desktop free icon layout', () => {
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

  it('cascades imported roots from a non-grid drop point without overlapping them', () => {
    expect(
      placeImportedDesktopRoots(
        ['document', 'folder'],
        { x: 173, y: 119 },
        { width: 800, height: 538 },
      ),
    ).toEqual([
      { nodeId: 'document', position: { x: 173, y: 119 } },
      { nodeId: 'folder', position: { x: 186, y: 130 } },
    ]);
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
