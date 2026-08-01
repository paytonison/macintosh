import { describe, expect, it } from 'vitest';

import { resolveCalculatorKeyboardAction } from './CalculatorWindow';

const eventFor = (
  key: string,
  modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key,
  metaKey: modifiers.metaKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  altKey: modifiers.altKey ?? false,
  shiftKey: modifiers.shiftKey ?? false,
});

describe('Calculator keyboard ownership', () => {
  it('owns supported keys, Escape, and unsupported printable text', () => {
    expect(resolveCalculatorKeyboardAction(eventFor('7'))).toEqual({
      type: 'input',
      input: '7',
    });
    expect(resolveCalculatorKeyboardAction(eventFor('Escape'))).toEqual({ type: 'close' });
    expect(resolveCalculatorKeyboardAction(eventFor('q'))).toEqual({ type: 'block' });
    expect(resolveCalculatorKeyboardAction(eventFor('💾'))).toEqual({ type: 'block' });
  });

  it('allows keyboard navigation and modified application shortcuts', () => {
    expect(resolveCalculatorKeyboardAction(eventFor('Tab'))).toEqual({ type: 'allow' });
    expect(resolveCalculatorKeyboardAction(eventFor('Tab', { shiftKey: true }))).toEqual({
      type: 'allow',
    });
    expect(resolveCalculatorKeyboardAction(eventFor('ArrowRight'))).toEqual({ type: 'allow' });
    expect(resolveCalculatorKeyboardAction(eventFor('z', { metaKey: true }))).toEqual({
      type: 'allow',
    });
  });
});
