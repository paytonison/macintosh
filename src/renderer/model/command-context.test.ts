import { describe, expect, it } from 'vitest';

import { createDefaultState, type MacintoshState } from '../../shared/state';
import {
  commandShortcut,
  deriveFinderCommandContext,
  finderCommandDestinationId,
  findMenuShortcutEntry,
  hasOpenDocumentInTrash,
  menuShortcutLabel,
  singleRenameableNode,
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

const withSystemDiskWindow = (): MacintoshState => {
  const state = createDefaultState();
  state.desktop.windows = [
    {
      id: 'window-system-disk',
      nodeId: 'system-disk',
      x: 170,
      y: 70,
      width: 640,
      height: 420,
    },
  ];
  return state;
};

describe('menu shortcut matching', () => {
  const menus = [
    {
      entries: [
        { id: 'new-folder', shortcut: commandShortcut('n') },
        { id: 'save-as', shortcut: commandShortcut('s', { shift: true }) },
        { id: 'open', shortcut: commandShortcut('o'), disabled: true },
      ],
    },
    { entries: [{ id: 'copy', shortcut: commandShortcut('c') }] },
  ];

  it('formats and finds enabled Command shortcuts across menus', () => {
    expect(menuShortcutLabel(commandShortcut('n'))).toBe('⌘N');
    expect(menuShortcutLabel(commandShortcut('s', { shift: true }))).toBe('⇧⌘S');
    expect(findMenuShortcutEntry(menus, shortcutEvent('N'))?.id).toBe('new-folder');
    expect(findMenuShortcutEntry(menus, shortcutEvent('c'))?.id).toBe('copy');
    expect(findMenuShortcutEntry(menus, shortcutEvent('s', { shiftKey: true }))?.id).toBe(
      'save-as',
    );
  });

  it('matches every modifier exactly and ignores unavailable shortcuts', () => {
    expect(
      findMenuShortcutEntry(menus, shortcutEvent('c', { metaKey: false, ctrlKey: true })),
    ).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('o'))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { metaKey: false }))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { ctrlKey: true }))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { altKey: true }))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('n', { shiftKey: true }))).toBeNull();
    expect(findMenuShortcutEntry(menus, shortcutEvent('s'))).toBeNull();
    expect(
      findMenuShortcutEntry(menus, shortcutEvent('s', { shiftKey: true, altKey: true })),
    ).toBeNull();
  });
});

describe('open Write documents in Trash', () => {
  it('recognizes direct and nested Trash descendants but not unrelated or untitled documents', () => {
    const state = createDefaultState();
    const readMe = state.nodes.find((node) => node.id === 'read-me')!;
    const nestedFolder = {
      ...state.nodes.find((node) => node.id === 'documents')!,
      id: 'trashed-folder',
      name: 'Trashed Folder',
      parentId: 'trash',
    };
    const nestedDocument = { ...readMe, id: 'nested-open', parentId: nestedFolder.id };
    const directDocument = { ...readMe, id: 'direct-open', parentId: 'trash' };
    const nodes = [...state.nodes, nestedFolder, nestedDocument, directDocument];

    expect(hasOpenDocumentInTrash(nodes, [])).toBe(false);
    expect(hasOpenDocumentInTrash(nodes, ['read-me'])).toBe(false);
    expect(hasOpenDocumentInTrash(nodes, ['direct-open'])).toBe(true);
    expect(hasOpenDocumentInTrash(nodes, ['nested-open'])).toBe(true);
    expect(hasOpenDocumentInTrash(nodes, ['missing'])).toBe(false);
  });
});

describe('Finder command context', () => {
  it('returns exactly one selected renameable document or folder', () => {
    const state = createDefaultState();

    expect(singleRenameableNode(state.nodes, ['read-me'])?.id).toBe('read-me');
    expect(singleRenameableNode(state.nodes, ['documents'])?.id).toBe('documents');
    expect(singleRenameableNode(state.nodes, [])).toBeNull();
    expect(singleRenameableNode(state.nodes, ['read-me', 'documents'])).toBeNull();
    expect(singleRenameableNode(state.nodes, ['system-disk'])).toBeNull();
    expect(singleRenameableNode(state.nodes, ['trash'])).toBeNull();
    expect(singleRenameableNode(state.nodes, ['write'])).toBeNull();
    expect(singleRenameableNode(state.nodes, ['missing'])).toBeNull();
  });

  it('uses Desktop when no active disk or folder window owns creation commands', () => {
    const state = withSystemDiskWindow();
    expect(finderCommandDestinationId(state, 'window-system-disk')).toBe('system-disk');
    expect(finderCommandDestinationId(state, null)).toBe('desktop');

    expect(
      finderCommandDestinationId(
        {
          ...state,
          desktop: { ...state.desktop, windows: [] },
        },
        'window-system-disk',
      ),
    ).toBe('desktop');

    expect(
      finderCommandDestinationId(
        {
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
        },
        'window-welcome',
      ),
    ).toBe('desktop');
  });

  it('keeps only selected nodes visible in the active Finder window', () => {
    const state = withSystemDiskWindow();
    const context = deriveFinderCommandContext(
      state,
      new Set(['read-me', 'applications', 'missing']),
      'window-system-disk',
    );

    expect(context.activeWindow?.id).toBe('window-system-disk');
    expect(context.activeNode?.id).toBe('system-disk');
    expect(context.visibleSelectionIds).toEqual(['applications']);
  });

  it('changes visible selection when another Finder window becomes frontmost', () => {
    const state = withSystemDiskWindow();
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
      new Set(['applications', 'welcome']),
      'window-documents',
    );

    expect(context.activeNode?.id).toBe('documents');
    expect(context.visibleSelection.map((node) => node.id)).toEqual(['welcome']);
  });

  it('has no visible Finder selection without an active window', () => {
    const state = createDefaultState();
    const context = deriveFinderCommandContext(
      { ...state, desktop: { ...state.desktop, windows: [] } },
      new Set(['applications']),
      null,
    );

    expect(context.activeWindow).toBeNull();
    expect(context.activeNode).toBeNull();
    expect(context.visibleSelectionIds).toEqual([]);
  });

  it('targets Desktop when the desktop owns Finder commands despite an open window', () => {
    const state = withSystemDiskWindow();
    const context = deriveFinderCommandContext(state, new Set(['applications']), null);

    expect(context.activeWindow).toBeNull();
    expect(context.activeNode).toBeNull();
    expect(context.visibleSelectionIds).toEqual([]);
    expect(finderCommandDestinationId(state, null)).toBe('desktop');
  });
});
