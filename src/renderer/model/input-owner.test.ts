import { describe, expect, it } from 'vitest';

import {
  activeApplicationAfterTarget,
  finderOrdinaryWindowId,
  raiseOrdinaryWindow,
  reconcileOrdinaryWindowOrder,
  resolveKeyboardOwner,
  writeOrdinaryWindowId,
  type KeyboardContext,
} from './input-owner';

const context = (overrides: Partial<KeyboardContext> = {}): KeyboardContext => ({
  persistenceAlertOpen: false,
  normalQuitInProgress: false,
  dialogOpen: false,
  ejectionInProgress: false,
  pointerSessionActive: false,
  menuOpen: false,
  activeTarget: { type: 'desktop' },
  ...overrides,
});

describe('keyboard input ownership', () => {
  it('changes applications for their own targets but preserves them for Calculator', () => {
    const write = { type: 'write' as const, windowId: 'write-one' };
    expect(activeApplicationAfterTarget(write, { type: 'calculator' })).toEqual(write);
    expect(activeApplicationAfterTarget(write, { type: 'desktop' })).toEqual({
      type: 'finder',
      windowId: null,
    });
    expect(
      activeApplicationAfterTarget(write, { type: 'finder-window', id: 'finder-documents' }),
    ).toEqual({ type: 'finder', windowId: 'finder-documents' });
    expect(
      activeApplicationAfterTarget(
        { type: 'finder', windowId: null },
        { type: 'write-window', id: 'write-two' },
      ),
    ).toEqual({ type: 'write', windowId: 'write-two' });
  });

  it('uses the current visible interaction target', () => {
    expect(resolveKeyboardOwner(context())).toBe('desktop');
    expect(
      resolveKeyboardOwner(context({ activeTarget: { type: 'finder-window', id: 'finder' } })),
    ).toBe('finder');
    expect(
      resolveKeyboardOwner(context({ activeTarget: { type: 'write-window', id: 'write' } })),
    ).toBe('write');
    expect(resolveKeyboardOwner(context({ activeTarget: { type: 'calculator' } }))).toBe(
      'calculator',
    );
    expect(
      resolveKeyboardOwner(context({ activeTarget: { type: 'calculator' }, menuOpen: true })),
    ).toBe('menu');
    expect(
      resolveKeyboardOwner(
        context({
          activeTarget: { type: 'calculator' },
          menuOpen: true,
          pointerSessionActive: true,
        }),
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
      activeTarget: { type: 'calculator' },
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

describe('ordinary window order', () => {
  const finderOne = finderOrdinaryWindowId('finder-one');
  const finderTwo = finderOrdinaryWindowId('finder-two');
  const writeOne = writeOrdinaryWindowId('write-one');

  it('raises Finder, Write, and Calculator in one back-to-front order', () => {
    let order = [finderOne, finderTwo, writeOne];
    order = raiseOrdinaryWindow(order, { type: 'finder-window', id: 'finder-one' });
    expect(order).toEqual([finderTwo, writeOne, finderOne]);
    order = raiseOrdinaryWindow(order, { type: 'calculator' });
    expect(order).toEqual([finderTwo, writeOne, finderOne, 'calculator']);
    order = raiseOrdinaryWindow(order, { type: 'write-window', id: 'write-one' });
    expect(order).toEqual([finderTwo, finderOne, 'calculator', writeOne]);
  });

  it('does not change window stacking when the desktop becomes the input target', () => {
    const order = [finderOne, writeOne, 'calculator' as const];
    expect(raiseOrdinaryWindow(order, { type: 'desktop' })).toBe(order);
  });

  it('drops closed windows, removes duplicates, and appends newly opened windows', () => {
    const order = reconcileOrdinaryWindowOrder(
      [finderOne, writeOne, finderOne, 'calculator'],
      [finderTwo, writeOne, 'calculator'],
    );
    expect(order).toEqual([writeOne, 'calculator', finderTwo]);
  });
});
