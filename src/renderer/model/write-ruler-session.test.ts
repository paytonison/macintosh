import { describe, expect, it } from 'vitest';

import {
  beginWriteRulerSession,
  completeWriteRulerSession,
  isWriteRulerRemovalPreview,
  updateWriteRulerSession,
  type WriteRulerGeometry,
} from './write-ruler-session';

const bounds = { left: 0, top: 0, width: 468, height: 28 };
const geometry: WriteRulerGeometry = {
  leftIndent: 0,
  rightIndent: 0,
  tabStops: [36, 72, 108],
};

describe('Write ruler pointer sessions', () => {
  it('previews a background tab and adds it only on a valid release', () => {
    const session = beginWriteRulerSession({
      pointerId: 1,
      kind: 'new-tab',
      pointer: { x: 90, y: 14 },
      bounds,
      geometry,
    });

    expect(session.current).toBe(90);
    expect(completeWriteRulerSession(session, true)).toEqual({
      type: 'tab-stops',
      value: [36, 72, 90, 108],
    });

    const releasedOutside = updateWriteRulerSession(session, { x: 90, y: 40 }, bounds);
    expect(completeWriteRulerSession(releasedOutside, true)).toBeNull();
  });

  it('moves a tab only when the pointer session commits', () => {
    const pressed = beginWriteRulerSession({
      pointerId: 2,
      kind: 'tab',
      tabIndex: 1,
      original: 72,
      pointer: { x: 72, y: 24 },
      bounds,
      geometry,
    });
    const preview = updateWriteRulerSession(pressed, { x: 96, y: 24 }, bounds);

    expect(preview.current).toBe(96);
    expect(completeWriteRulerSession(preview, false)).toBeNull();
    expect(completeWriteRulerSession(preview, true)).toEqual({
      type: 'tab-stops',
      value: [36, 96, 108],
    });
  });

  it('previews and commits removal when a tab is dragged off the ruler', () => {
    const pressed = beginWriteRulerSession({
      pointerId: 3,
      kind: 'tab',
      tabIndex: 1,
      original: 72,
      pointer: { x: 72, y: 24 },
      bounds,
      geometry,
    });
    const preview = updateWriteRulerSession(pressed, { x: 72, y: 40 }, bounds);

    expect(isWriteRulerRemovalPreview(preview)).toBe(true);
    expect(completeWriteRulerSession(preview, true)).toEqual({
      type: 'tab-stops',
      value: [36, 108],
    });
  });

  it('restores committed state after cancellation or lost capture', () => {
    const pressed = beginWriteRulerSession({
      pointerId: 4,
      kind: 'left-indent',
      original: 0,
      pointer: { x: 0, y: 24 },
      bounds,
      geometry,
    });
    const preview = updateWriteRulerSession(pressed, { x: 48, y: 24 }, bounds);

    expect(preview.current).toBe(48);
    expect(completeWriteRulerSession(preview, false)).toBeNull();
  });

  it('does not turn sub-threshold pointer jitter into a marker mutation', () => {
    const pressed = beginWriteRulerSession({
      pointerId: 5,
      kind: 'right-indent',
      original: 0,
      pointer: { x: 468, y: 24 },
      bounds,
      geometry,
    });
    const jitter = updateWriteRulerSession(pressed, { x: 466, y: 24 }, bounds);

    expect(jitter.current).toBe(0);
    expect(completeWriteRulerSession(jitter, true)).toBeNull();
  });
});
