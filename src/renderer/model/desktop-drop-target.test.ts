import { describe, expect, it } from 'vitest';

import {
  isPointInTrashDropBounds,
  TRASH_DROP_TOLERANCE_CSS_PX,
  type ClientBounds,
} from './desktop-drop-target';

const glyph: ClientBounds = { left: 100, right: 128, top: 50, bottom: 81 };
const label: ClientBounds = { left: 96, right: 132, top: 87, bottom: 104 };

describe('Trash drop bounds', () => {
  it('accepts the visible glyph and its documented edge tolerance', () => {
    expect(isPointInTrashDropBounds({ x: 100, y: 50 }, glyph, label)).toBe(true);
    expect(
      isPointInTrashDropBounds(
        { x: glyph.right + TRASH_DROP_TOLERANCE_CSS_PX, y: glyph.bottom },
        glyph,
        label,
      ),
    ).toBe(true);
  });

  it('rejects the first point beyond the padded glyph and the label area', () => {
    expect(
      isPointInTrashDropBounds(
        { x: glyph.right + TRASH_DROP_TOLERANCE_CSS_PX + 0.01, y: glyph.bottom },
        glyph,
        label,
      ),
    ).toBe(false);
    expect(isPointInTrashDropBounds({ x: 114, y: 95 }, glyph, label)).toBe(false);
  });

  it('uses the same client-coordinate predicate for scaled rendered bounds', () => {
    const scale = 1.5;
    const scaledGlyph = {
      left: glyph.left * scale,
      right: glyph.right * scale,
      top: glyph.top * scale,
      bottom: glyph.bottom * scale,
    };
    const scaledLabel = {
      left: label.left * scale,
      right: label.right * scale,
      top: label.top * scale,
      bottom: label.bottom * scale,
    };

    expect(
      isPointInTrashDropBounds(
        { x: scaledGlyph.left - TRASH_DROP_TOLERANCE_CSS_PX, y: scaledGlyph.top },
        scaledGlyph,
        scaledLabel,
      ),
    ).toBe(true);
    expect(
      isPointInTrashDropBounds(
        { x: scaledGlyph.left - TRASH_DROP_TOLERANCE_CSS_PX - 0.01, y: scaledGlyph.top },
        scaledGlyph,
        scaledLabel,
      ),
    ).toBe(false);
  });
});
