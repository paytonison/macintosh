import { describe, expect, it } from 'vitest';

import { createDefaultState } from '../../shared/state';
import {
  addFolder,
  duplicateNodes,
  emptyTrash,
  listChildren,
  mergeImportedEntries,
  moveNodes,
  placeFinderIcons,
  rectanglesOverlap,
} from './vfs';

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

  it('imports folder trees and resolves duplicate document names', () => {
    const state = createDefaultState();
    const imported = mergeImportedEntries(
      state,
      [
        {
          name: 'Read Me',
          kind: 'document',
          content: 'first imported copy',
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
        },
        {
          name: 'Project',
          kind: 'folder',
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
          children: [
            {
              name: 'Notes.txt',
              kind: 'document',
              content: 'nested document',
              createdAt: '2026-07-22T12:00:00.000Z',
              modifiedAt: '2026-07-22T12:00:00.000Z',
            },
          ],
        },
      ],
      'documents',
    );

    const copy = imported.state.nodes.find(
      (node) => node.parentId === 'documents' && node.name === 'Read Me copy',
    );
    const project = imported.state.nodes.find(
      (node) => node.parentId === 'documents' && node.name === 'Project',
    );
    expect(copy?.content).toBe('first imported copy');
    expect(imported.state.nodes.find((node) => node.parentId === project?.id)).toMatchObject({
      name: 'Notes.txt',
      content: 'nested document',
    });
  });

  it('moves folders to valid targets but refuses descendant cycles', () => {
    const state = createDefaultState();
    const moved = moveNodes(state, ['applications'], 'trash', '2026-07-22T12:00:00.000Z');
    expect(moved.state.nodes.find((node) => node.id === 'applications')?.parentId).toBe('trash');

    const nested = mergeImportedEntries(
      state,
      [
        {
          name: 'Parent',
          kind: 'folder',
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
          children: [
            {
              name: 'Child',
              kind: 'folder',
              createdAt: '2026-07-22T12:00:00.000Z',
              modifiedAt: '2026-07-22T12:00:00.000Z',
            },
          ],
        },
      ],
      'system-disk',
    );
    const parent = nested.state.nodes.find((node) => node.name === 'Parent');
    const child = nested.state.nodes.find((node) => node.parentId === parent?.id);
    const refused = moveNodes(nested.state, [parent?.id ?? ''], child?.id ?? '');

    expect(refused.state).toBe(nested.state);
    expect(refused.affectedIds).toEqual([]);
  });

  it('places icons freely without changing filesystem metadata', () => {
    const state = createDefaultState();
    const before = state.nodes.find((node) => node.id === 'applications');
    const positioned = placeFinderIcons(state, 'system-disk', [
      { nodeId: 'applications', position: { x: 173, y: 119 } },
    ]);
    const after = positioned.nodes.find((node) => node.id === 'applications');

    expect(after).toEqual({ ...before, iconPosition: { x: 173, y: 119 } });
    expect(after?.parentId).toBe('system-disk');
    expect(after?.modifiedAt).toBe(before?.modifiedAt);
    expect(positioned.nodes).toHaveLength(state.nodes.length);
  });

  it('moves a root without carrying its old parent-relative position', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!applications) throw new Error('Missing VFS fixture.');
    applications.iconPosition = { x: 173, y: 119 };
    state.nodes.push({
      id: 'sample-application',
      parentId: 'applications',
      name: 'Sample',
      kind: 'document',
      iconPosition: { x: 91, y: 77 },
      createdAt: '2026-07-22T12:00:00.000Z',
      modifiedAt: '2026-07-22T12:00:00.000Z',
    });

    const moved = moveNodes(state, ['applications'], 'trash', '2026-07-22T12:00:00.000Z');

    expect(
      moved.state.nodes.find((node) => node.id === 'applications')?.iconPosition,
    ).toBeUndefined();
    expect(
      moved.state.nodes.find((node) => node.id === 'sample-application')?.iconPosition,
    ).toEqual({ x: 91, y: 77 });
  });

  it('duplicates selected documents with their contents', () => {
    const state = createDefaultState();
    const duplicated = duplicateNodes(state, ['read-me'], 'documents', '2026-07-22T12:00:00.000Z');
    const copy = duplicated.state.nodes.find(
      (node) => node.parentId === 'documents' && node.name === 'Read Me copy',
    );

    expect(copy?.id).not.toBe('read-me');
    expect(copy?.content).toBe(
      'No ROMs, copied system files, or extracted proprietary artwork are used by this application.',
    );
  });

  it('auto-places copied roots while retaining layout inside copied folders', () => {
    const state = createDefaultState();
    const documents = state.nodes.find((node) => node.id === 'documents');
    const readMe = state.nodes.find((node) => node.id === 'read-me');
    if (!documents || !readMe) throw new Error('Missing copy fixtures.');
    documents.iconPosition = { x: 173, y: 119 };
    readMe.iconPosition = { x: 87, y: 133 };

    const duplicated = duplicateNodes(
      state,
      ['documents'],
      'system-disk',
      '2026-07-22T12:00:00.000Z',
    );
    const copiedFolder = duplicated.state.nodes.find(
      (node) => node.parentId === 'system-disk' && node.name === 'Documents copy',
    );
    const copiedReadMe = duplicated.state.nodes.find(
      (node) => node.parentId === copiedFolder?.id && node.name === 'Read Me',
    );

    expect(copiedFolder?.iconPosition).toBeUndefined();
    expect(copiedReadMe?.iconPosition).toEqual({ x: 87, y: 133 });
  });
});
