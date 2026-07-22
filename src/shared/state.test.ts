import { describe, expect, it } from 'vitest';

import { createDefaultState, sanitizeState } from './state';

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
});
