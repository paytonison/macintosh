import { describe, expect, it } from 'vitest';

import { initialDesktopIconPosition } from './desktop-icon-position';
import { createDefaultState, sanitizeState, STATE_SCHEMA_VERSION } from './state';

describe('persistent Macintosh state', () => {
  it('creates the three required roots, including a hidden Desktop container', () => {
    const state = createDefaultState();

    expect(state.nodes.find((node) => node.id === 'system-disk')?.kind).toBe('disk');
    expect(state.nodes.find((node) => node.id === 'trash')?.kind).toBe('trash');
    expect(state.nodes.find((node) => node.id === 'desktop')).toMatchObject({
      kind: 'desktop',
      parentId: null,
    });
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
    const repairedMalformed = sanitizeState(malformed);

    expect(repairedMalformed.nodes.find((node) => node.id === 'desktop')).toEqual({
      ...desktop,
      parentId: null,
      iconPosition: undefined,
    });
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

  it('materializes identity-derived Desktop positions independently of node array order', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    const documents = state.nodes.find((node) => node.id === 'documents');
    if (!applications || !documents) throw new Error('Missing Desktop position fixtures.');
    applications.parentId = 'desktop';
    documents.parentId = 'desktop';

    const reordered = { ...state, nodes: [...state.nodes].reverse() };
    const originalPositions = new Map(
      sanitizeState(state).nodes.map((node) => [node.id, node.iconPosition]),
    );
    const reorderedPositions = new Map(
      sanitizeState(reordered).nodes.map((node) => [node.id, node.iconPosition]),
    );

    for (const nodeId of ['applications', 'documents']) {
      const position = originalPositions.get(nodeId);
      expect(position).toEqual(initialDesktopIconPosition(nodeId));
      expect(Number.isInteger(position?.x)).toBe(true);
      expect(Number.isInteger(position?.y)).toBe(true);
      expect(reorderedPositions.get(nodeId)).toEqual(position);
    }
  });

  it('keeps required roots inside the canonical node cap', () => {
    const state = createDefaultState();
    const timestamp = '2026-07-22T12:00:00.000Z';
    state.nodes = Array.from({ length: 512 }, (_, index) => ({
      id: `document-${index}`,
      parentId: 'desktop',
      name: `Document ${index}`,
      kind: 'document' as const,
      createdAt: timestamp,
      modifiedAt: timestamp,
    }));

    const safe = sanitizeState(state);

    expect(safe.nodes).toHaveLength(512);
    expect(safe.nodes.some((node) => node.id === 'system-disk')).toBe(true);
    expect(safe.nodes.some((node) => node.id === 'trash')).toBe(true);
    expect(safe.nodes.some((node) => node.id === 'desktop')).toBe(true);
    expect(
      safe.nodes
        .filter((node) => node.parentId === 'desktop')
        .every((node) => node.iconPosition !== undefined),
    ).toBe(true);
  });

  it('drops forged non-root volume kinds instead of rendering unpersisted Desktop items', () => {
    const state = createDefaultState();
    state.nodes.push({
      id: 'forged-volume',
      parentId: 'desktop',
      name: 'Forged Volume',
      kind: 'disk',
      createdAt: '2026-07-22T12:00:00.000Z',
      modifiedAt: '2026-07-22T12:00:00.000Z',
    });

    expect(sanitizeState(state).nodes.some((node) => node.id === 'forged-volume')).toBe(false);
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
