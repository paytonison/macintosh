import { describe, expect, it } from 'vitest';

import { createDefaultState, MAX_VFS_NODES } from '../../shared/state';
import { createDefaultWriteParagraphStyle, type DocumentPayload } from '../../shared/write';
import {
  addFolder,
  duplicateNodes,
  emptyTrash,
  executeVfsCommand,
  isVfsCommand,
  listChildren,
  mergeImportedEntries,
  moveNodes,
  placeFinderIcons,
  rectanglesOverlap,
  MAX_VFS_CONTENT,
} from '../../shared/vfs';

const richPayload = (): DocumentPayload => ({
  format: 'write-v1',
  pagePreset: 'us-letter-1in',
  blocks: [
    {
      type: 'paragraph',
      style: {
        ...createDefaultWriteParagraphStyle(),
        alignment: 'center',
        lineSpacing: 1.5,
        tabStops: [36, 108, 216],
      },
      content: [
        {
          type: 'text',
          text: 'Exact',
          marks: [
            { type: 'bold' },
            { type: 'underline' },
            { type: 'font-family-serif' },
            { type: 'font-size-14' },
          ],
        },
        { type: 'tab' },
        {
          type: 'text',
          text: 'copy',
          marks: [{ type: 'italic' }, { type: 'font-family-serif' }, { type: 'font-size-14' }],
        },
      ],
    },
    { type: 'page-break' },
    {
      type: 'paragraph',
      style: createDefaultWriteParagraphStyle(),
      content: [{ type: 'text', text: 'Second page' }],
    },
  ],
});

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
    expect(imported.addedCount).toBe(3);
    expect(copy?.payload).toEqual({ format: 'plain-text', text: 'first imported copy' });
    expect(imported.state.nodes.find((node) => node.parentId === project?.id)).toMatchObject({
      name: 'Notes.txt',
      payload: { format: 'plain-text', text: 'nested document' },
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

  it('moves a System Disk child to the first-class Desktop root', () => {
    const state = createDefaultState();
    const moved = moveNodes(state, ['applications'], 'desktop', '2026-07-22T12:00:00.000Z');

    expect(moved.affectedIds).toEqual(['applications']);
    expect(moved.state.nodes.find((node) => node.id === 'applications')).toMatchObject({
      parentId: 'desktop',
      modifiedAt: '2026-07-22T12:00:00.000Z',
    });
  });

  it('resolves case-insensitive name collisions on Desktop without overwriting', () => {
    const state = createDefaultState();
    const documents = state.nodes.find((node) => node.id === 'documents');
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!documents || !applications) throw new Error('Missing collision fixtures.');
    documents.parentId = 'desktop';
    documents.name = 'Applications';

    const moved = moveNodes(state, ['applications'], 'desktop');

    expect(moved.state.nodes.find((node) => node.id === 'documents')?.name).toBe('Applications');
    expect(moved.state.nodes.find((node) => node.id === 'applications')).toMatchObject({
      parentId: 'desktop',
      name: 'Applications copy',
    });
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

  it('repositions an item within Desktop without changing its parent or timestamps', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!applications) throw new Error('Missing Desktop placement fixture.');
    applications.parentId = 'desktop';
    applications.iconPosition = { x: 83, y: 47 };
    const before = { ...applications };

    const positioned = placeFinderIcons(state, 'desktop', [
      { nodeId: 'applications', position: { x: 173, y: 119 } },
    ]);

    expect(positioned.nodes.find((node) => node.id === 'applications')).toEqual({
      ...before,
      iconPosition: { x: 173, y: 119 },
    });
  });

  it('positions imported Desktop roots while leaving their nested hierarchy intact', () => {
    const imported = executeVfsCommand(createDefaultState(), {
      type: 'merge-imported-entries',
      entries: [
        {
          name: 'Drop Folder',
          kind: 'folder',
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
          children: [
            {
              name: 'Nested Note.txt',
              kind: 'document',
              content: 'nested',
              createdAt: '2026-07-22T12:00:00.000Z',
              modifiedAt: '2026-07-22T12:00:00.000Z',
            },
          ],
        },
        {
          name: 'Dropped Note.txt',
          kind: 'document',
          content: 'top level',
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
        },
      ],
      parentId: 'desktop',
      desktopPlacement: {
        point: { x: 173, y: 119 },
        surfaceSize: { width: 800, height: 538 },
      },
    });
    const folder = imported.state.nodes.find((node) => node.name === 'Drop Folder');
    const document = imported.state.nodes.find((node) => node.name === 'Dropped Note.txt');
    const nested = imported.state.nodes.find((node) => node.parentId === folder?.id);

    expect(folder).toMatchObject({ parentId: 'desktop', iconPosition: { x: 173, y: 119 } });
    expect(document).toMatchObject({ parentId: 'desktop', iconPosition: { x: 186, y: 130 } });
    expect(nested).toMatchObject({
      name: 'Nested Note.txt',
      payload: { format: 'plain-text', text: 'nested' },
    });
    expect(nested?.iconPosition).toBeUndefined();
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

  it('clears a Desktop-relative root position when moving to another container', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!applications) throw new Error('Missing Desktop move fixture.');
    applications.parentId = 'desktop';
    applications.iconPosition = { x: 173, y: 119 };

    const moved = moveNodes(state, ['applications'], 'system-disk', '2026-07-22T12:00:00.000Z');

    expect(moved.state.nodes.find((node) => node.id === 'applications')).toMatchObject({
      parentId: 'system-disk',
      modifiedAt: '2026-07-22T12:00:00.000Z',
    });
    expect(
      moved.state.nodes.find((node) => node.id === 'applications')?.iconPosition,
    ).toBeUndefined();
  });

  it('duplicates selected documents with their contents', () => {
    const state = createDefaultState();
    const duplicated = duplicateNodes(state, ['read-me'], 'documents', '2026-07-22T12:00:00.000Z');
    const copy = duplicated.state.nodes.find(
      (node) => node.parentId === 'documents' && node.name === 'Read Me copy',
    );

    expect(duplicated.addedCount).toBe(1);
    expect(copy?.id).not.toBe('read-me');
    expect(copy?.payload).toEqual({
      format: 'plain-text',
      text: 'No ROMs, copied system files, or extracted proprietary artwork are used by this application.',
    });
  });

  it('duplicates rich documents without demoting or rewriting their payload', () => {
    const state = createDefaultState();
    const source = state.nodes.find((node) => node.id === 'read-me');
    if (!source) throw new Error('Missing rich duplicate fixture.');
    source.payload = richPayload();

    const duplicated = duplicateNodes(state, [source.id], 'documents', '2026-07-22T12:00:00.000Z');
    const copy = duplicated.state.nodes.find(
      (node) => node.parentId === 'documents' && node.name === 'Read Me copy',
    );

    expect(duplicated).toMatchObject({
      affectedIds: [copy?.id],
      addedCount: 1,
      skippedCount: 0,
      truncatedCount: 0,
    });
    expect(copy?.payload).toEqual(source.payload);
    expect(copy?.payload?.format).toBe('write-v1');
    expect(source.payload).toEqual(richPayload());
  });

  it('moves a rich document into and out of Trash without changing its payload', () => {
    const state = createDefaultState();
    const source = state.nodes.find((node) => node.id === 'read-me');
    if (!source) throw new Error('Missing rich Trash fixture.');
    source.payload = richPayload();

    const trashed = moveNodes(state, [source.id], 'trash', '2026-07-22T12:00:00.000Z');
    const trashedNode = trashed.state.nodes.find((node) => node.id === source.id);
    expect(trashedNode).toEqual({
      ...source,
      parentId: 'trash',
      iconPosition: undefined,
      modifiedAt: '2026-07-22T12:00:00.000Z',
    });
    expect(trashedNode?.payload).toEqual(richPayload());

    const restored = moveNodes(trashed.state, [source.id], 'documents', '2026-07-22T12:01:00.000Z');
    expect(restored.state.nodes.find((node) => node.id === source.id)).toEqual({
      ...source,
      parentId: 'documents',
      iconPosition: undefined,
      modifiedAt: '2026-07-22T12:01:00.000Z',
    });
  });

  it('skips a whole duplicate when exact content or the full node tree cannot fit', () => {
    const contentLimited = createDefaultState();
    const source = contentLimited.nodes.find((node) => node.id === 'read-me');
    if (!source) throw new Error('Missing content-cap fixture.');
    source.payload = {
      format: 'write-v1',
      pagePreset: 'us-letter-1in',
      blocks: [
        {
          type: 'paragraph',
          style: createDefaultWriteParagraphStyle(),
          content: [{ type: 'text', text: 'x'.repeat(Math.floor(MAX_VFS_CONTENT / 2) + 1) }],
        },
      ],
    };

    expect(duplicateNodes(contentLimited, [source.id], 'documents')).toEqual({
      state: contentLimited,
      affectedIds: [],
      addedCount: 0,
      skippedCount: 1,
      truncatedCount: 0,
    });

    const nodeLimited = createDefaultState();
    while (nodeLimited.nodes.length < MAX_VFS_NODES - 1) {
      const index = nodeLimited.nodes.length;
      nodeLimited.nodes.push({
        id: `copy-cap-filler-${index}`,
        parentId: 'system-disk',
        name: `Copy cap filler ${index}`,
        kind: 'document',
        createdAt: '2026-07-22T12:00:00.000Z',
        modifiedAt: '2026-07-22T12:00:00.000Z',
      });
    }

    expect(duplicateNodes(nodeLimited, ['documents'], 'system-disk')).toEqual({
      state: nodeLimited,
      affectedIds: [],
      addedCount: 0,
      skippedCount: 2,
      truncatedCount: 0,
    });
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

  it('executes typed create commands and returns the new root IDs', () => {
    const timestamp = '2026-07-22T12:00:00.000Z';
    const folder = executeVfsCommand(
      createDefaultState(),
      { type: 'create-folder', parentId: 'documents' },
      timestamp,
    );
    const createdFolder = folder.state.nodes.find((node) => node.id === folder.affectedIds[0]);
    expect(createdFolder).toMatchObject({
      parentId: 'documents',
      name: 'untitled folder',
      kind: 'folder',
      createdAt: timestamp,
    });

    const document = executeVfsCommand(
      folder.state,
      {
        type: 'create-document',
        parentId: 'documents',
        name: 'Read Me',
        payload: { format: 'plain-text', text: 'a pasted document' },
      },
      timestamp,
    );
    expect(document.state.nodes.find((node) => node.id === document.affectedIds[0])).toMatchObject({
      parentId: 'documents',
      name: 'Read Me copy',
      kind: 'document',
      payload: { format: 'plain-text', text: 'a pasted document' },
    });

    const oversizedBase = createDefaultState();
    const oversized = executeVfsCommand(oversizedBase, {
      type: 'create-document',
      parentId: 'documents',
      name: 'Large Note',
      payload: { format: 'plain-text', text: 'x'.repeat(192 * 1024 + 1) },
    });
    expect(oversized.state).toBe(oversizedBase);
    expect(oversized.affectedIds).toEqual([]);
    expect(oversized.skippedCount).toBe(1);
    expect(oversized.truncatedCount).toBe(1);

    const createdId = document.affectedIds[0]!;
    const updated = executeVfsCommand(
      document.state,
      {
        type: 'update-document',
        nodeId: createdId,
        payload: {
          format: 'write-v1',
          pagePreset: 'us-letter-1in',
          blocks: [
            {
              type: 'paragraph',
              style: {
                fontFamily: 'sans',
                fontSize: 12,
                alignment: 'left',
                leftIndent: 0,
                firstLineIndent: 0,
                rightIndent: 0,
                tabStops: [36],
                lineSpacing: 1,
              },
              content: [
                {
                  type: 'text',
                  text: 'saved',
                  marks: [{ type: 'bold' }, { type: 'font-family-serif' }],
                },
              ],
            },
          ],
        },
      },
      '2026-07-22T12:01:00.000Z',
    );
    expect(updated.state.nodes.find((node) => node.id === createdId)).toMatchObject({
      payload: {
        format: 'write-v1',
        blocks: [
          {
            content: [
              {
                type: 'text',
                text: 'saved',
                marks: [{ type: 'bold' }, { type: 'font-family-serif' }],
              },
            ],
          },
        ],
      },
      modifiedAt: '2026-07-22T12:01:00.000Z',
    });

    const unchanged = executeVfsCommand(
      updated.state,
      {
        type: 'update-document',
        nodeId: createdId,
        payload: updated.state.nodes.find((node) => node.id === createdId)?.payload ?? {
          format: 'plain-text',
          text: '',
        },
      },
      '2026-07-22T12:02:00.000Z',
    );
    expect(unchanged.state).toBe(updated.state);
    expect(unchanged.state.nodes.find((node) => node.id === createdId)?.modifiedAt).toBe(
      '2026-07-22T12:01:00.000Z',
    );

    const rejectedUpdate = executeVfsCommand(updated.state, {
      type: 'update-document',
      nodeId: createdId,
      payload: { format: 'plain-text', text: 'x'.repeat(MAX_VFS_CONTENT + 1) },
    });
    expect(rejectedUpdate.state).toBe(updated.state);
    expect(rejectedUpdate).toMatchObject({
      affectedIds: [],
      skippedCount: 1,
      truncatedCount: 1,
    });
  });

  it('rejects malformed commands before mutating state', () => {
    const state = createDefaultState();
    const internalImport = {
      type: 'merge-imported-entries',
      entries: [],
      parentId: 'desktop',
    };

    expect(() => executeVfsCommand(state, { type: 'erase-everything' })).toThrow(TypeError);
    expect(isVfsCommand(internalImport)).toBe(false);
    expect(() =>
      executeVfsCommand(state, {
        type: 'move-nodes',
        nodeIds: ['applications'],
        parentId: 'desktop',
        placements: [],
        desktopPlacement: {
          point: { x: 20, y: 20 },
          surfaceSize: { width: 640, height: 480 },
        },
      }),
    ).toThrow(TypeError);
    expect(() => executeVfsCommand(state, { type: 'create-folder', parentId: 'trash' })).toThrow(
      TypeError,
    );
    expect(() =>
      executeVfsCommand(state, {
        type: 'create-document',
        parentId: 'trash',
        name: 'Bypass',
        content: 'must not persist',
      }),
    ).toThrow(TypeError);
    expect(() =>
      executeVfsCommand(state, {
        type: 'duplicate-nodes',
        nodeIds: ['welcome'],
        parentId: 'trash',
      }),
    ).toThrow(TypeError);
    expect(() =>
      executeVfsCommand(state, {
        type: 'duplicate-nodes',
        nodeIds: ['welcome'],
        parentId: 'desktop',
        desktopPlacement: {
          point: { x: 20, y: 20 },
          surfaceSize: { width: 640, height: 480 },
        },
      }),
    ).toThrow(TypeError);
    expect(
      isVfsCommand({
        type: 'update-document',
        nodeId: 'read-me',
        payload: { format: 'write-v1', pagePreset: 'us-letter-1in' },
      }),
    ).toBe(false);
    expect(
      isVfsCommand({
        type: 'update-document',
        nodeId: 'read-me',
        payload: {
          format: 'write-v1',
          pagePreset: 'us-letter-1in',
          blocks: [
            {
              type: 'paragraph',
              style: {
                fontFamily: 'serif',
                fontSize: 12,
                alignment: 'left',
                leftIndent: 0,
                firstLineIndent: 0,
                rightIndent: 0,
                tabStops: [],
                lineSpacing: 1,
              },
              content: [{ type: 'text', text: 'forged', marks: [{ type: 'blink' }] }],
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isVfsCommand({
        type: 'update-document',
        nodeId: 'read-me',
        payload: {
          format: 'write-v1',
          pagePreset: 'us-letter-1in',
          blocks: [
            {
              type: 'paragraph',
              style: {
                fontFamily: 'sans',
                fontSize: 12,
                alignment: 'right',
                leftIndent: 12,
                firstLineIndent: 6,
                rightIndent: 18,
                tabStops: [36, 72],
                lineSpacing: 1.5,
              },
              content: [
                {
                  type: 'text',
                  text: 'valid',
                  marks: [
                    { type: 'underline' },
                    { type: 'font-family-mono' },
                    { type: 'font-size-10' },
                  ],
                },
              ],
            },
            { type: 'page-break' },
          ],
        },
      }),
    ).toBe(true);
    expect(state).toBe(state);
    expect(state.nodes.find((node) => node.id === 'applications')?.parentId).toBe('system-disk');
  });

  it('rejects structurally valid document payloads that require lossy canonicalization', () => {
    const state = createDefaultState();
    const command = {
      type: 'create-document' as const,
      parentId: 'documents',
      name: 'Noncanonical',
      payload: {
        format: 'write-v1' as const,
        pagePreset: 'us-letter-1in' as const,
        blocks: [
          {
            type: 'paragraph' as const,
            style: { ...createDefaultWriteParagraphStyle(), leftIndent: 999 },
            content: [
              {
                type: 'text' as const,
                text: 'formatting matters',
                marks: [{ type: 'bold' as const }, { type: 'bold' as const }],
              },
            ],
          },
        ],
      },
    };

    expect(isVfsCommand(command)).toBe(true);
    expect(executeVfsCommand(state, command)).toMatchObject({
      state,
      affectedIds: [],
      skippedCount: 1,
      truncatedCount: 1,
    });
  });

  it('uses the final VFS node slot and rejects additions after the cap is reached', () => {
    const state = createDefaultState();
    while (state.nodes.length < MAX_VFS_NODES - 1) {
      const index = state.nodes.length;
      state.nodes.push({
        id: `filler-${index}`,
        parentId: 'documents',
        name: `Filler ${index}`,
        kind: 'document',
        createdAt: '2026-07-22T12:00:00.000Z',
        modifiedAt: '2026-07-22T12:00:00.000Z',
      });
    }

    const atCapacity = addFolder(state, 'documents');

    expect(atCapacity.nodes).toHaveLength(MAX_VFS_NODES);
    expect(atCapacity).not.toBe(state);
    expect(addFolder(atCapacity, 'documents')).toBe(atCapacity);
    expect(executeVfsCommand(atCapacity, { type: 'create-folder', parentId: 'documents' })).toEqual(
      {
        state: atCapacity,
        affectedIds: [],
        addedCount: 0,
        skippedCount: 1,
        truncatedCount: 0,
      },
    );
  });

  it('terminates ancestor walks and duplication on malformed parent cycles', () => {
    const state = createDefaultState();
    state.nodes.push(
      {
        id: 'cycle-a',
        parentId: 'cycle-b',
        name: 'Cycle A',
        kind: 'folder',
        createdAt: '2026-07-22T12:00:00.000Z',
        modifiedAt: '2026-07-22T12:00:00.000Z',
      },
      {
        id: 'cycle-b',
        parentId: 'cycle-a',
        name: 'Cycle B',
        kind: 'folder',
        createdAt: '2026-07-22T12:00:00.000Z',
        modifiedAt: '2026-07-22T12:00:00.000Z',
      },
      {
        id: 'cycle-child',
        parentId: 'cycle-a',
        name: 'Cycle Child',
        kind: 'document',
        createdAt: '2026-07-22T12:00:00.000Z',
        modifiedAt: '2026-07-22T12:00:00.000Z',
      },
    );

    const moved = executeVfsCommand(state, {
      type: 'move-nodes',
      nodeIds: ['cycle-child'],
      parentId: 'trash',
    });
    expect(moved.affectedIds).toEqual(['cycle-child']);
    expect(moved.state.nodes.find((node) => node.id === 'cycle-child')?.parentId).toBe('trash');

    const duplicated = executeVfsCommand(state, {
      type: 'duplicate-nodes',
      nodeIds: ['cycle-a'],
      parentId: 'documents',
    });
    expect(duplicated.state.nodes.length).toBeLessThanOrEqual(MAX_VFS_NODES);
    expect(duplicated.skippedCount).toBeGreaterThan(0);
  });

  it('atomically applies exact move placements only to affected roots', () => {
    const state = createDefaultState();
    const readMeBefore = state.nodes.find((node) => node.id === 'read-me');
    const moved = executeVfsCommand(state, {
      type: 'move-nodes',
      nodeIds: ['applications'],
      parentId: 'documents',
      placements: [
        { nodeId: 'applications', position: { x: 121, y: 88 } },
        { nodeId: 'read-me', position: { x: 700, y: 700 } },
      ],
    });

    expect(moved.state.nodes.find((node) => node.id === 'applications')).toMatchObject({
      parentId: 'documents',
      iconPosition: { x: 121, y: 88 },
    });
    expect(moved.state.nodes.find((node) => node.id === 'read-me')).toEqual(readMeBefore);
  });

  it('places list-view move roots from their Desktop release point', () => {
    const state = createDefaultState();
    const readMeBefore = state.nodes.find((node) => node.id === 'read-me');
    const moved = executeVfsCommand(state, {
      type: 'move-nodes',
      nodeIds: ['applications', 'documents'],
      parentId: 'desktop',
      desktopPlacement: {
        point: { x: 173, y: 119 },
        surfaceSize: { width: 800, height: 538 },
      },
    });

    expect(moved.affectedIds).toEqual(['applications', 'documents']);
    expect(moved.state.nodes.find((node) => node.id === 'applications')).toMatchObject({
      parentId: 'desktop',
      iconPosition: { x: 173, y: 119 },
    });
    expect(moved.state.nodes.find((node) => node.id === 'documents')).toMatchObject({
      parentId: 'desktop',
      iconPosition: { x: 186, y: 130 },
    });
    expect(moved.state.nodes.find((node) => node.id === 'read-me')).toEqual(readMeBefore);
  });

  it('accepts Desktop move release points but rejects ambiguous or non-Desktop placement', () => {
    const desktopPlacement = {
      point: { x: 173, y: 119 },
      surfaceSize: { width: 800, height: 538 },
    };

    expect(
      isVfsCommand({
        type: 'move-nodes',
        nodeIds: ['applications'],
        parentId: 'desktop',
        desktopPlacement,
      }),
    ).toBe(true);
    expect(
      isVfsCommand({
        type: 'move-nodes',
        nodeIds: ['applications'],
        parentId: 'documents',
        desktopPlacement,
      }),
    ).toBe(false);
    expect(
      isVfsCommand({
        type: 'move-nodes',
        nodeIds: ['applications'],
        parentId: 'desktop',
        placements: [],
        desktopPlacement,
      }),
    ).toBe(false);
  });

  it('clamps an explicit import cascade while retaining free-form offsets', () => {
    const timestamp = '2026-07-22T12:00:00.000Z';
    const result = executeVfsCommand(
      createDefaultState(),
      {
        type: 'merge-imported-entries',
        entries: [
          {
            name: 'First',
            kind: 'document',
            createdAt: timestamp,
            modifiedAt: timestamp,
          },
          {
            name: 'Second',
            kind: 'document',
            createdAt: timestamp,
            modifiedAt: timestamp,
          },
        ],
        parentId: 'desktop',
        desktopPlacement: {
          point: { x: 900, y: 900 },
          surfaceSize: { width: 200, height: 150 },
        },
      },
      timestamp,
    );
    const positions = result.affectedIds.map(
      (id) => result.state.nodes.find((node) => node.id === id)?.iconPosition,
    );

    expect(positions).toEqual([
      { x: 105, y: 61 },
      { x: 118, y: 72 },
    ]);
  });

  it('executes internal imported-entry and empty-Trash commands with uniform results', () => {
    const imported = executeVfsCommand(createDefaultState(), {
      type: 'merge-imported-entries',
      parentId: 'desktop',
      entries: [
        {
          name: 'Imported Note',
          kind: 'document',
          content: 'hello',
          createdAt: '2026-07-22T12:00:00.000Z',
          modifiedAt: '2026-07-22T12:00:00.000Z',
        },
      ],
      desktopPlacement: {
        point: { x: 77, y: 55 },
        surfaceSize: { width: 640, height: 480 },
      },
    });
    const importedId = imported.affectedIds[0];
    expect(imported.state.nodes.find((node) => node.id === importedId)).toMatchObject({
      parentId: 'desktop',
      iconPosition: { x: 77, y: 55 },
    });

    const moved = executeVfsCommand(imported.state, {
      type: 'move-nodes',
      nodeIds: [importedId ?? ''],
      parentId: 'trash',
    });
    const emptied = executeVfsCommand(moved.state, { type: 'empty-trash' });
    expect(emptied).toMatchObject({
      affectedIds: [importedId],
      addedCount: 0,
      skippedCount: 0,
      truncatedCount: 0,
    });
    expect(emptied.state.nodes.some((node) => node.id === importedId)).toBe(false);
    expect(emptied.state.nodes.some((node) => node.id === 'trash')).toBe(true);
  });
});
