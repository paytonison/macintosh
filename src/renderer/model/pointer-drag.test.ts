import { describe, expect, it } from 'vitest';

import {
  POINTER_DRAG_THRESHOLD,
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
} from './pointer-drag';

describe('pointer drag intent', () => {
  it('keeps a stationary or sub-threshold press as a click', () => {
    const pressed = beginPointerDrag({ x: 20, y: 30 });

    expect(updatePointerDrag(pressed, { x: 20, y: 30 })).toBe(pressed);
    expect(updatePointerDrag(pressed, { x: 23, y: 30 })).toBe(pressed);
    expect(releasePointerDrag(pressed)).toBe('click');
  });

  it('begins dragging at the shared Euclidean movement threshold', () => {
    const pressed = beginPointerDrag({ x: 10, y: 10 });
    const diagonal = updatePointerDrag(pressed, { x: 12.4, y: 13.2 });
    const exact = updatePointerDrag(pressed, {
      x: 10 + POINTER_DRAG_THRESHOLD,
      y: 10,
    });

    expect(diagonal.phase).toBe('dragging');
    expect(exact.phase).toBe('dragging');
    expect(releasePointerDrag(exact)).toBe('drag');
  });

  it('stays in the dragging phase until the owning session ends', () => {
    const dragging = updatePointerDrag(beginPointerDrag({ x: 5, y: 5 }), { x: 9, y: 5 });

    expect(updatePointerDrag(dragging, { x: 5, y: 5 })).toBe(dragging);
    expect(releasePointerDrag(dragging)).toBe('drag');

    const nextInteraction = beginPointerDrag({ x: 50, y: 60 });
    expect(nextInteraction.phase).toBe('pressed');
    expect(releasePointerDrag(nextInteraction)).toBe('click');
  });
});
