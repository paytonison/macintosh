import { describe, expect, it } from 'vitest';

import { createDefaultState } from '../../shared/state';
import {
  deriveFinderCommandContext,
  finderCommandDestinationId,
  findMenuShortcutEntry,
  menuShortcutLabel,
} from './command-context';

const shortcutEvent = (
  key: string,
  overrides: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe('menu shortcut matching', () => {
  const menus = [
    {
      entries: [
        { id: 'new-folder', shortcut: 'n' as const },
        { id: 'open', shortcut: 'o' as const, disabled: true },
      ],
    },
    { entries: [{ id: 'copy', shortcut: 'c' as const }] },
  ];

  it('formats and finds enabled Command shortcuts across menus', () => {
    expect(menuShortcutLabel('n')).toBe('⌘N');
    expect(findMenuShortcutEntry(menus, shortcutEvent('N'))?.id).toBe('new-folder');
    expect(findMenuShortcutEntry(menus, shortcutEvent('c'))?.id).toBe('copy');
  });

  it('requires Command and ignores unavailable or additionally modified shortcuts', () => {
    expect(
      findMenuShortcutEntry(menus, shortcutEvent('c', { metaKey: false, ctrlKey: true })),
    ).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('o'))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { metaKey: false }))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { ctrlKey: true }))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { altKey: true }))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { shiftKey: true }))).toBeNull();
  });
});

describe('Finder command context', () => {
  it('uses Desktop when no active disk or folder window owns creation commands', () => {
    const state = createDefaultState();
    expect(finderCommandDestinationId(state)).toBe('system-disk');

    expect(
      finderCommandDestinationId({
        ...state,
        desktop: { ...state.desktop, windows: [] },
      }),
    ).toBe('desktop');

    expect(
      finderCommandDestinationId({
        ...state,
        desktop: {
          ...state.desktop,
          windows: [
            {
              id: 'window-welcome',
              nodeId: 'welcome',
              x: 100,
              y: 100,
              width: 520,
              height: 390,
            },
          ],
        },
      }),
    ).toBe('desktop');
  });

  it('keeps only selected nodes visible in the active Finder window', () => {
    const state = createDefaultState();
    const context = deriveFinderCommandContext(
      state,
      new Set(['read-me', 'applications', 'missing']),
    );

    expect(context.activeWindow?.id).toBe('window-system-disk');
    expect(context.activeNode?.id).toBe('system-disk');
    expect(context.visibleSelectionIds).toEqual(['applications']);
  });

  it('changes visible selection when another Finder window becomes frontmost', () => {
    const state = createDefaultState();
    const documentsWindow = {
      id: 'window-documents',
      nodeId: 'documents',
      x: 270,
      y: 130,
      width: 640,
      height: 420,
    };
    const context = deriveFinderCommandContext(
      {
        ...state,
        desktop: {
          ...state.desktop,
          windows: [...state.desktop.windows, documentsWindow],
        },
      },
      new Set(['applications', 'read-me']),
    );

    expect(context.activeNode?.id).toBe('documents');
    expect(context.visibleSelection.map((node) => node.id)).toEqual(['read-me']);
  });

  it('has no visible Finder selection without an active window', () => {
    const state = createDefaultState();
    const context = deriveFinderCommandContext(
      { ...state, desktop: { ...state.desktop, windows: [] } },
      new Set(['applications']),
    );

    expect(context.activeWindow).toBeNull();
    expect(context.activeNode).toBeNull();
    expect(context.visibleSelectionIds).toEqual([]);
  });
});
