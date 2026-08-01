import { describe, expect, it } from 'vitest';

import { resolveKeyboardOwner, type KeyboardContext } from './input-owner';

const context = (overrides: Partial<KeyboardContext> = {}): KeyboardContext => ({
  persistenceAlertOpen: false,
  normalQuitInProgress: false,
  dialogOpen: false,
  ejectionInProgress: false,
  pointerSessionActive: false,
  menuOpen: false,
  writeWindowOpen: false,
  calculatorOpen: false,
  finderWindowOpen: false,
  ...overrides,
});

describe('keyboard input ownership', () => {
  it('uses the current visible interaction target', () => {
    expect(resolveKeyboardOwner(context())).toBe('desktop');
    expect(resolveKeyboardOwner(context({ finderWindowOpen: true }))).toBe('finder');
    expect(resolveKeyboardOwner(context({ finderWindowOpen: true, writeWindowOpen: true }))).toBe(
      'write',
    );
    expect(resolveKeyboardOwner(context({ finderWindowOpen: true, calculatorOpen: true }))).toBe(
      'calculator',
    );
    expect(resolveKeyboardOwner(context({ calculatorOpen: true, menuOpen: true }))).toBe('menu');
    expect(
      resolveKeyboardOwner(
        context({ calculatorOpen: true, menuOpen: true, pointerSessionActive: true }),
      ),
    ).toBe('pointer-session');
  });

  it('gives system transactions and modal surfaces precedence', () => {
    const occupied = context({
      persistenceAlertOpen: true,
      normalQuitInProgress: true,
      dialogOpen: true,
      ejectionInProgress: true,
      pointerSessionActive: true,
      menuOpen: true,
      calculatorOpen: true,
      finderWindowOpen: true,
    });

    expect(resolveKeyboardOwner(occupied)).toBe('persistence-alert');
    expect(resolveKeyboardOwner({ ...occupied, persistenceAlertOpen: false })).toBe('normal-quit');
    expect(
      resolveKeyboardOwner({
        ...occupied,
        persistenceAlertOpen: false,
        normalQuitInProgress: false,
      }),
    ).toBe('dialog');
    expect(
      resolveKeyboardOwner({
        ...occupied,
        persistenceAlertOpen: false,
        normalQuitInProgress: false,
        dialogOpen: false,
      }),
    ).toBe('ejection');
    expect(
      resolveKeyboardOwner({
        ...occupied,
        persistenceAlertOpen: false,
        normalQuitInProgress: false,
        dialogOpen: false,
        ejectionInProgress: false,
      }),
    ).toBe('pointer-session');
  });
});
