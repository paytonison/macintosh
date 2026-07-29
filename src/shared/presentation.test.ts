import { describe, expect, it } from 'vitest';

import { createDefaultState } from './state';
import { mergePresentation, projectPresentation } from './presentation';

describe('presentation persistence boundary', () => {
  it('projects only desktop presentation and parent-scoped icon positions', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!applications) throw new Error('Missing Applications fixture.');
    applications.iconPosition = { x: 173, y: 119 };

    expect(projectPresentation(state)).toEqual({
      desktop: {
        diskPosition: state.desktop.diskPosition,
        trashPosition: state.desktop.trashPosition,
        windows: state.desktop.windows,
        viewMode: state.desktop.viewMode,
      },
      iconPositions: [
        {
          nodeId: 'applications',
          parentId: 'system-disk',
          position: { x: 173, y: 119 },
        },
      ],
    });
  });

  it('updates layout without accepting renderer-provided VFS replacement data', () => {
    const state = createDefaultState();
    const currentWelcome = state.nodes.find((node) => node.id === 'welcome');
    if (!currentWelcome) throw new Error('Missing Welcome fixture.');

    const merged = mergePresentation(state, {
      desktop: {
        ...state.desktop,
        diskPosition: { x: 511, y: 207 },
      },
      iconPositions: [
        {
          nodeId: 'welcome',
          parentId: 'system-disk',
          position: { x: 173, y: 119 },
        },
      ],
      nodes: [
        {
          ...currentWelcome,
          name: 'Renderer replacement',
          content: 'Renderer replacement',
        },
      ],
    });

    expect(merged.desktop.diskPosition).toEqual({ x: 511, y: 207 });
    expect(merged.nodes.find((node) => node.id === 'welcome')).toEqual({
      ...currentWelcome,
      iconPosition: { x: 173, y: 119 },
    });
    expect(merged.nodes).toHaveLength(state.nodes.length);
  });

  it('rejects stale or forged icon positions whose parent does not match', () => {
    const state = createDefaultState();
    const applications = state.nodes.find((node) => node.id === 'applications');
    if (!applications) throw new Error('Missing Applications fixture.');
    applications.iconPosition = { x: 40, y: 50 };

    const merged = mergePresentation(state, {
      desktop: state.desktop,
      iconPositions: [
        {
          nodeId: 'applications',
          parentId: 'desktop',
          position: { x: 600, y: 500 },
        },
      ],
    });

    expect(merged.nodes.find((node) => node.id === 'applications')?.iconPosition).toEqual({
      x: 40,
      y: 50,
    });
  });

  it('preserves the authoritative presentation when a partial patch omits fields', () => {
    const state = createDefaultState();
    state.desktop.diskPosition = { x: 711, y: 203 };
    state.desktop.trashPosition = { x: 617, y: 449 };
    state.desktop.lastEjectAt = '2026-07-28T15:00:00.000Z';

    const merged = mergePresentation(state, {
      desktop: {
        diskPosition: { x: Number.NaN, y: 19 },
        trashPosition: 'invalid',
        windows: [{ id: 'forged' }],
        viewMode: 'list',
        lastEjectAt: null,
      },
    });

    expect(merged.desktop.diskPosition).toEqual({ x: 711, y: 203 });
    expect(merged.desktop.trashPosition).toEqual({ x: 617, y: 449 });
    expect(merged.desktop.windows).toEqual(state.desktop.windows);
    expect(merged.desktop.viewMode).toBe('list');
    expect(merged.desktop.lastEjectAt).toBe('2026-07-28T15:00:00.000Z');
  });
});
