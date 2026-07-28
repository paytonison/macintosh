import { describe, expect, it } from 'vitest';

import { createDefaultState, sanitizeState, STATE_SCHEMA_VERSION } from './state';

describe('persistent Macintosh state', () => {
  it('creates a virtual disk and a non-deletable Trash root', () => {
    const state = createDefaultState();

    expect(state.nodes.find((node) => node.id === 'system-disk')?.kind).toBe('disk');
    expect(state.nodes.find((node) => node.id === 'trash')?.kind).toBe('trash');
    expect(state.desktop.windows[0]?.nodeId).toBe('system-disk');
  });

  it('falls back safely when required roots are removed', () => {
    const damaged = createDefaultState();
    damaged.nodes = damaged.nodes.filter((node) => node.id !== 'system-disk');

    const restored = sanitizeState(damaged);

    expect(restored.nodes.some((node) => node.id === 'system-disk')).toBe(true);
    expect(restored.nodes.some((node) => node.id === 'trash')).toBe(true);
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

  it('migrates version 1 state without resetting its desktop or virtual disk', () => {
    const legacy = createDefaultState();
    legacy.desktop.diskPosition = { x: 731, y: 137 };
    legacy.desktop.windows[0] = { ...legacy.desktop.windows[0]!, x: 319, y: 117 };

    const migrated = sanitizeState({ ...legacy, schemaVersion: 1 });

    expect(migrated.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    expect(migrated.desktop.diskPosition).toEqual({ x: 731, y: 137 });
    expect(migrated.desktop.windows[0]).toMatchObject({ x: 319, y: 117 });
    expect(migrated.nodes.map((node) => node.id)).toEqual(legacy.nodes.map((node) => node.id));
  });

  it('preserves arbitrary child icon positions without snapping them to a grid', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!applications) throw new Error('Missing Applications fixture.');
    applications.iconPosition = { x: 173, y: 119 };

    const safe = sanitizeState(state);

    expect(safe.nodes.find((node) => node.id === 'applications')?.iconPosition).toEqual({
      x: 173,
      y: 119,
    });
  });

  it('rounds and bounds Finder positions while omitting malformed and root positions', () => {
    const state = createDefaultState();
    const disk = state.nodes.find((node) => node.id === 'system-disk');
    const applications = state.nodes.find((node) => node.id === 'applications');
    const documents = state.nodes.find((node) => node.id === 'documents');
    if (!disk || !applications || !documents) throw new Error('Missing state fixtures.');
    disk.iconPosition = { x: 12, y: 24 };
    applications.iconPosition = { x: -4.4, y: 9000.2 };
    documents.iconPosition = { x: Number.NaN, y: 88 };

    const safe = sanitizeState(state);

    expect(safe.nodes.find((node) => node.id === 'system-disk')?.iconPosition).toBeUndefined();
    expect(safe.nodes.find((node) => node.id === 'applications')?.iconPosition).toEqual({
      x: 0,
      y: 8192,
    });
    expect(safe.nodes.find((node) => node.id === 'documents')?.iconPosition).toBeUndefined();
  });
});
