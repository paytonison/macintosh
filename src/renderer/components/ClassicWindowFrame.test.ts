import { describe, expect, it } from 'vitest';

import { shouldCancelClassicWindowCapture } from './ClassicWindowFrame';

describe('classic window lost pointer capture', () => {
  it('cancels every matching active geometry session', () => {
    expect(shouldCancelClassicWindowCapture(41, 41)).toBe(true);
  });

  it('ignores capture loss from another pointer or with no active session', () => {
    expect(shouldCancelClassicWindowCapture(41, 42)).toBe(false);
    expect(shouldCancelClassicWindowCapture(null, 41)).toBe(false);
  });
});
