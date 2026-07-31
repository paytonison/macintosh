import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_ITEM_CREATED_AT,
  canonicalCreatedAtForNodeId,
  createDefaultState,
  MAX_VFS_NODES,
  sanitizeState,
  STATE_SCHEMA_VERSION,
  SYSTEM_DISK_CREATED_AT,
  type VfsNode,
} from './state';

const BUILT_IN_ITEM_IDS = [
  'trash',
  'system-folder',
  'applications',
  'documents',
  'utilities',
  'welcome',
  'finder-notes',
  'read-me',
] as const;

describe('persistent Macintosh state', () => {
  it('creates the required roots and canonical built-in creation metadata', () => {
    const state = createDefaultState();

    expect(state.nodes.find((node) => node.id === 'system-disk')).toMatchObject({
      kind: 'disk',
      createdAt: SYSTEM_DISK_CREATED_AT,
    });
    for (const id of BUILT_IN_ITEM_IDS) {
      expect(state.nodes.find((node) => node.id === id)?.createdAt).toBe(BUILT_IN_ITEM_CREATED_AT);
    }
    expect(state.nodes.find((node) => node.id === 'desktop')).toMatchObject({
      kind: 'desktop',
      parentId: null,
      createdAt: '1989-01-24T09:00:00.000Z',
    });
    expect(canonicalCreatedAtForNodeId('desktop')).toBeNull();
    expect(state.desktop.windows.some((windowState) => windowState.nodeId === 'desktop')).toBe(
      false,
    );
    expect(state.desktop.windows[0]?.nodeId).toBe('system-disk');
  });

  it('falls back safely when required roots are removed', () => {
    const damaged = createDefaultState();
    damaged.nodes = damaged.nodes.filter((node) => node.id !== 'system-disk');

    const restored = sanitizeState(damaged);

    expect(restored.nodes.some((node) => node.id === 'system-disk')).toBe(true);
    expect(restored.nodes.some((node) => node.id === 'trash')).toBe(true);
    expect(restored.nodes.some((node) => node.id === 'desktop')).toBe(true);
  });

  it.each([1, 2, STATE_SCHEMA_VERSION])(
    'normalizes canonical creation dates in schema %i without rewriting other metadata',
    (schemaVersion) => {
      const saved = createDefaultState();
      const canonicalIds = ['system-disk', ...BUILT_IN_ITEM_IDS];
      const systemFolder = saved.nodes.find((node) => node.id === 'system-folder');
      const welcome = saved.nodes.find((node) => node.id === 'welcome');
      const applications = saved.nodes.find((node) => node.id === 'applications');
      const desktop = saved.nodes.find((node) => node.id === 'desktop');
      if (!systemFolder || !welcome || !applications || !desktop) {
        throw new Error('Missing timestamp fixtures.');
      }

      const duplicateCreatedAt = '2026-07-30T18:45:00.000Z';
      const customCreatedAt = '2026-07-31T14:20:00.000Z';
      const importedCreatedAt = '2026-07-31T15:30:00.000Z';
      const desktopCreatedAt = '2026-07-31T16:40:00.000Z';
      const builtInModifiedAt = '2026-07-31T17:50:00.000Z';
      const applicationsCopy: VfsNode = {
        ...applications,
        id: 'folder-applications-copy',
        name: 'Applications copy',
        createdAt: duplicateCreatedAt,
        modifiedAt: duplicateCreatedAt,
      };
      const customDocument: VfsNode = {
        id: 'document-custom',
        parentId: 'system-disk',
        name: 'Custom Note',
        kind: 'document',
        content: 'Preserve this custom document.',
        createdAt: customCreatedAt,
        modifiedAt: customCreatedAt,
      };
      const importedDocument: VfsNode = {
        id: 'document-imported',
        parentId: 'system-disk',
        name: 'Imported Note',
        kind: 'document',
        content: 'Preserve this import.',
        iconPosition: { x: 211, y: 137 },
        createdAt: importedCreatedAt,
        modifiedAt: importedCreatedAt,
      };

      for (const id of canonicalIds) {
        const node = saved.nodes.find((candidate) => candidate.id === id);
        if (!node) throw new Error(`Missing canonical fixture ${id}.`);
        node.createdAt = '1989-01-24T09:00:00.000Z';
        node.modifiedAt = builtInModifiedAt;
      }
      systemFolder.parentId = 'desktop';
      systemFolder.name = 'Moved System Folder';
      systemFolder.iconPosition = { x: 173, y: 119 };
      welcome.content = 'Preserve this built-in content.';
      desktop.createdAt = desktopCreatedAt;
      saved.nodes.push(applicationsCopy, customDocument, importedDocument);

      const canonicalNodesBeforeNormalization = new Map(
        canonicalIds.map((id) => {
          const node = saved.nodes.find((candidate) => candidate.id === id);
          if (!node) throw new Error(`Missing canonical fixture ${id}.`);
          return [
            id,
            {
              ...node,
              ...(node.iconPosition ? { iconPosition: { ...node.iconPosition } } : {}),
            },
          ] as const;
        }),
      );

      const normalized = sanitizeState({ ...saved, schemaVersion });

      for (const id of canonicalIds) {
        expect(normalized.nodes.find((node) => node.id === id)).toEqual({
          ...canonicalNodesBeforeNormalization.get(id),
          createdAt: id === 'system-disk' ? SYSTEM_DISK_CREATED_AT : BUILT_IN_ITEM_CREATED_AT,
        });
      }
      expect(normalized.nodes.find((node) => node.id === applicationsCopy.id)).toMatchObject({
        createdAt: duplicateCreatedAt,
        modifiedAt: duplicateCreatedAt,
      });
      expect(normalized.nodes.find((node) => node.id === customDocument.id)).toEqual(
        customDocument,
      );
      expect(normalized.nodes.find((node) => node.id === importedDocument.id)).toEqual(
        importedDocument,
      );
      expect(normalized.nodes.find((node) => node.id === 'desktop')?.createdAt).toBe(
        desktopCreatedAt,
      );
      expect(canonicalCreatedAtForNodeId(applicationsCopy.id)).toBeNull();
    },
  );

  it('repairs a missing or malformed Desktop root without discarding valid nodes', () => {
    const missing = createDefaultState();
    missing.nodes = missing.nodes.filter((node) => node.id !== 'desktop');

    const repairedMissing = sanitizeState(missing);

    expect(repairedMissing.nodes.find((node) => node.id === 'desktop')).toMatchObject({
      kind: 'desktop',
      parentId: null,
    });
    expect(repairedMissing.nodes.some((node) => node.id === 'welcome')).toBe(true);

    const malformed = createDefaultState();
    const desktop = malformed.nodes.find((node) => node.id === 'desktop');
    if (!desktop) throw new Error('Missing Desktop fixture.');
    desktop.parentId = 'system-disk';
    desktop.iconPosition = { x: 83, y: 47 };
    malformed.desktop.windows.push({
      id: 'window-desktop',
      nodeId: 'desktop',
      x: 100,
      y: 100,
      width: 640,
      height: 420,
    });

    const repairedMalformed = sanitizeState(malformed);

    expect(repairedMalformed.nodes.find((node) => node.id === 'desktop')).toEqual({
      ...desktop,
      parentId: null,
      iconPosition: undefined,
    });
    expect(repairedMalformed.desktop.windows.some((item) => item.nodeId === 'desktop')).toBe(false);
  });

  it('clamps untrusted geometry and preserves a valid eject timestamp', () => {
    const state = createDefaultState();
    state.desktop.diskPosition = { x: Number.POSITIVE_INFINITY, y: -99999 };
    state.desktop.lastEjectAt = '2026-07-22T12:00:00.000Z';

    const safe = sanitizeState(state);

    expect(safe.desktop.diskPosition.x).toBe(createDefaultState().desktop.diskPosition.x);
    expect(safe.desktop.diskPosition.y).toBe(-256);
    expect(safe.desktop.lastEjectAt).toBe('2026-07-22T12:00:00.000Z');
  });

  it.each([1, 2])(
    'migrates version %i state without resetting its desktop or virtual disk',
    (schemaVersion) => {
      const legacy = createDefaultState();
      legacy.nodes = legacy.nodes.filter((node) => node.id !== 'desktop');
      legacy.desktop.diskPosition = { x: 731, y: 137 };
      legacy.desktop.trashPosition = { x: 97, y: 611 };
      legacy.desktop.windows[0] = { ...legacy.desktop.windows[0]!, x: 319, y: 117 };
      legacy.desktop.viewMode = 'list';
      legacy.desktop.lastEjectAt = '2026-07-22T12:00:00.000Z';
      const welcome = legacy.nodes.find((node) => node.id === 'welcome');
      if (!welcome) throw new Error('Missing legacy fixture.');
      welcome.name = 'Preserved Welcome';
      welcome.iconPosition = { x: 173, y: 119 };

      const migrated = sanitizeState({ ...legacy, schemaVersion });

      expect(migrated.schemaVersion).toBe(STATE_SCHEMA_VERSION);
      expect(migrated.desktop.diskPosition).toEqual({ x: 731, y: 137 });
      expect(migrated.desktop.trashPosition).toEqual({ x: 97, y: 611 });
      expect(migrated.desktop.windows[0]).toMatchObject({ x: 319, y: 117 });
      expect(migrated.desktop.viewMode).toBe('list');
      expect(migrated.desktop.lastEjectAt).toBe('2026-07-22T12:00:00.000Z');
      expect(migrated.nodes.find((node) => node.id === 'welcome')).toMatchObject({
        name: 'Preserved Welcome',
        iconPosition: { x: 173, y: 119 },
      });
      expect(migrated.nodes.find((node) => node.id === 'desktop')).toMatchObject({
        kind: 'desktop',
        parentId: null,
      });
      expect(migrated.nodes.filter((node) => node.id !== 'desktop').map((node) => node.id)).toEqual(
        legacy.nodes.map((node) => node.id),
      );
    },
  );

  it('preserves the prior ordinary-node capacity while inserting Desktop during migration', () => {
    const seed = createDefaultState();
    const roots = seed.nodes.filter((node) => node.id === 'system-disk' || node.id === 'trash');
    const timestamp = '2026-07-22T12:00:00.000Z';
    const ordinary = Array.from({ length: 510 }, (_, index): VfsNode => ({
      id: `legacy-${index}`,
      parentId: 'system-disk',
      name: `Legacy ${index}`,
      kind: 'document',
      createdAt: timestamp,
      modifiedAt: timestamp,
    }));

    const migrated = sanitizeState({ ...seed, schemaVersion: 2, nodes: [...roots, ...ordinary] });

    expect(migrated.nodes).toHaveLength(MAX_VFS_NODES);
    expect(migrated.nodes.some((node) => node.id === 'desktop')).toBe(true);
    expect(migrated.nodes.some((node) => node.id === 'legacy-509')).toBe(true);
  });

  it('preserves arbitrary Desktop-child positions without snapping them to a grid', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!applications) throw new Error('Missing Applications fixture.');
    applications.parentId = 'desktop';
    applications.iconPosition = { x: 173, y: 119 };

    const safe = sanitizeState(state);

    expect(safe.nodes.find((node) => node.id === 'applications')?.iconPosition).toEqual({
      x: 173,
      y: 119,
    });
    expect(safe.nodes.find((node) => node.id === 'applications')?.parentId).toBe('desktop');
  });

  it('materializes a stable Desktop position from node identity when one is missing', () => {
    const state = createDefaultState();
    const fixture: VfsNode = {
      id: 'desktop-note-stable',
      parentId: 'desktop',
      name: 'Desktop Note',
      kind: 'document',
      createdAt: '2026-07-22T12:00:00.000Z',
      modifiedAt: '2026-07-22T12:00:00.000Z',
    };

    const first = sanitizeState({ ...state, nodes: [...state.nodes, fixture] });
    const reordered = sanitizeState({ ...state, nodes: [fixture, ...state.nodes].reverse() });

    expect(first.nodes.find((node) => node.id === fixture.id)?.iconPosition).toEqual(
      reordered.nodes.find((node) => node.id === fixture.id)?.iconPosition,
    );
  });

  it('rounds and bounds Finder positions while omitting malformed and root positions', () => {
    const state = createDefaultState();
    const disk = state.nodes.find((node) => node.id === 'system-disk');
    const desktop = state.nodes.find((node) => node.id === 'desktop');
    const applications = state.nodes.find((node) => node.id === 'applications');
    const documents = state.nodes.find((node) => node.id === 'documents');
    if (!disk || !desktop || !applications || !documents) {
      throw new Error('Missing state fixtures.');
    }
    disk.iconPosition = { x: 12, y: 24 };
    desktop.iconPosition = { x: 33, y: 45 };
    applications.iconPosition = { x: -4.4, y: 9000.2 };
    documents.iconPosition = { x: Number.NaN, y: 88 };

    const safe = sanitizeState(state);

    expect(safe.nodes.find((node) => node.id === 'system-disk')?.iconPosition).toBeUndefined();
    expect(safe.nodes.find((node) => node.id === 'desktop')?.iconPosition).toBeUndefined();
    expect(safe.nodes.find((node) => node.id === 'applications')?.iconPosition).toEqual({
      x: 0,
      y: 8192,
    });
    expect(safe.nodes.find((node) => node.id === 'documents')?.iconPosition).toBeUndefined();
  });
});
