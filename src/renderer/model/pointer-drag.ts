import type { Point } from '../../shared/state';

export const POINTER_DRAG_THRESHOLD = 4;

export interface PointerDragIntent {
  origin: Point;
  phase: 'pressed' | 'dragging';
}

export const beginPointerDrag = (origin: Point): PointerDragIntent => ({
  origin,
  phase: 'pressed',
});

export const updatePointerDrag = (intent: PointerDragIntent, pointer: Point): PointerDragIntent => {
  if (
    intent.phase === 'dragging' ||
    Math.hypot(pointer.x - intent.origin.x, pointer.y - intent.origin.y) >= POINTER_DRAG_THRESHOLD
  ) {
    return intent.phase === 'dragging' ? intent : { ...intent, phase: 'dragging' };
  }
  return intent;
};

export const releasePointerDrag = (intent: PointerDragIntent): 'click' | 'drag' =>
  intent.phase === 'dragging' ? 'drag' : 'click';
