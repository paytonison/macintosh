import { describe, expect, it } from 'vitest';

import { createDefaultState } from '../../shared/state';
import { addFolder, emptyTrash, listChildren, rectanglesOverlap } from './vfs';

describe('virtual Finder helpers', () => {
  it('sorts list view without disturbing icon insertion order', () => {
    const state = createDefaultState();
    const icons = listChildren(state.nodes, 'system-disk', 'icons');
    const list = listChildren(state.nodes, 'system-disk', 'list');

    expect(icons[0]?.name).toBe('System Folder');
    expect(list.map((node) => node.name)).toEqual(
      [...list.map((node) => node.name)].sort((left, right) => left.localeCompare(right)),
    );
  });

  it('creates collision-free folder names', () => {
    let state = addFolder(createDefaultState(), 'system-disk', '2026-07-22T12:00:00.000Z');
    state = addFolder(state, 'system-disk', '2026-07-22T12:01:00.000Z');

    expect(state.nodes.some((node) => node.name === 'untitled folder')).toBe(true);
    expect(state.nodes.some((node) => node.name === 'untitled folder 2')).toBe(true);
  });

  it('empties Trash recursively without removing its root', () => {
    const state = createDefaultState();
    const withTrashItem = {
      ...state,
      nodes: [
        ...state.nodes,
        {
          id: 'discarded',
          parentId: 'trash',
          name: 'discarded',
          kind: 'folder' as const,
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
        },
        {
          id: 'discarded-child',
          parentId: 'discarded',
          name: 'discarded child',
          kind: 'document' as const,
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
        },
      ],
    };

    const emptied = emptyTrash(withTrashItem);

    expect(emptied.nodes.some((node) => node.id === 'trash')).toBe(true);
    expect(emptied.nodes.some((node) => node.id === 'discarded')).toBe(false);
    expect(emptied.nodes.some((node) => node.id === 'discarded-child')).toBe(false);
  });

  it('detects marquee and drop-target overlap', () => {
    expect(
      rectanglesOverlap(
        { left: 0, top: 0, right: 20, bottom: 20 },
        { left: 15, top: 15, right: 30, bottom: 30 },
      ),
    ).toBe(true);
    expect(
      rectanglesOverlap(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 10, top: 10, right: 20, bottom: 20 },
      ),
    ).toBe(false);
  });
});
