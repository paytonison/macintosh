import { describe, expect, it } from 'vitest';

import { formatMenuClock, millisecondsUntilNextMinute } from './clock';

describe('menu clock', () => {
  it('formats only the current hour and minute', () => {
    const minuteStart = new Date(2026, 7, 13, 1, 4, 0, 0);
    const minuteEnd = new Date(2026, 7, 13, 1, 4, 59, 999);

    expect(formatMenuClock(minuteEnd)).toBe(formatMenuClock(minuteStart));
  });

  it.each([
    [new Date(2026, 7, 13, 1, 13, 0, 0), 60_000],
    [new Date(2026, 7, 13, 1, 13, 42, 250), 17_750],
    [new Date(2026, 7, 13, 1, 13, 59, 999), 1],
  ])('aligns the next refresh to a wall-clock minute boundary', (date, expected) => {
    expect(millisecondsUntilNextMinute(date)).toBe(expected);
  });
});
