import { describe, expect, it } from 'vitest';

import { projectPresentation } from '../shared/presentation';
import { createDefaultState, type MacintoshState } from '../shared/state';
import { createAuthoritativeStateController } from './state-controller';

describe('authoritative state controller', () => {
  it('serializes transitions and never loses an earlier committed mutation', async () => {
    const writes: MacintoshState[] = [];
    const controller = createAuthoritativeStateController({
      load: async () => createDefaultState(),
      write: async (state) => {
        writes.push(structuredClone(state));
      },
    });
    const presentation = projectPresentation(createDefaultState());

    const first = controller.transact(presentation, (state) => ({
      state: {
        ...state,
        nodes: state.nodes.map((node) =>
          node.id === 'welcome' ? { ...node, name: 'First mutation' } : node,
        ),
      },
      value: 'first',
    }));
    const second = controller.transact(presentation, (state) => ({
      state: {
        ...state,
        nodes: state.nodes.map((node) =>
          node.id === 'read-me' ? { ...node, name: 'Second mutation' } : node,
        ),
      },
      value: 'second',
    }));

    await Promise.all([first, second]);
    const loaded = await controller.load();

    expect(loaded.nodes.find((node) => node.id === 'welcome')?.name).toBe('First mutation');
    expect(loaded.nodes.find((node) => node.id === 'read-me')?.name).toBe('Second mutation');
    expect(writes).toHaveLength(2);
  });

  it('does not advance canonical state when the atomic write fails', async () => {
    let writes = 0;
    const controller = createAuthoritativeStateController({
      load: async () => createDefaultState(),
      write: async () => {
        writes += 1;
        if (writes === 1) throw new Error('disk full');
      },
    });
    const presentation = projectPresentation(createDefaultState());

    await expect(
      controller.transact(presentation, (state) => ({
        state: {
          ...state,
          nodes: state.nodes.map((node) =>
            node.id === 'welcome' ? { ...node, name: 'Uncommitted mutation' } : node,
          ),
        },
        value: null,
      })),
    ).rejects.toThrow('disk full');

    expect((await controller.load()).nodes.find((node) => node.id === 'welcome')?.name).toBe(
      'Welcome',
    );
  });

  it('merges a presentation patch without allowing it to replace VFS contents', async () => {
    let written: MacintoshState | null = null;
    const original = createDefaultState();
    const controller = createAuthoritativeStateController({
      load: async () => original,
      write: async (state) => {
        written = state;
      },
    });
    const patch = projectPresentation(original);
    patch.desktop = { ...patch.desktop, trashPosition: { x: 401, y: 299 } };
    (patch as unknown as { nodes: unknown[] }).nodes = [];

    await controller.savePresentation(patch);

    expect(written?.desktop.trashPosition).toEqual({ x: 401, y: 299 });
    expect(written?.nodes).toHaveLength(original.nodes.length);
  });

  it('orders asynchronous transitions and closes successful finalization to later writes', async () => {
    const writes: MacintoshState[] = [];
    let releaseImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const controller = createAuthoritativeStateController({
      load: async () => createDefaultState(),
      write: async (state) => {
        writes.push(structuredClone(state));
      },
    });
    const initial = createDefaultState();
    const importPresentation = projectPresentation(initial);
    const ejectPresentation = projectPresentation({
      ...initial,
      desktop: {
        ...initial.desktop,
        trashPosition: { x: 410, y: 318 },
      },
    });

    const slowImport = controller.transact(importPresentation, async (state) => {
      await importGate;
      return {
        state: {
          ...state,
          nodes: state.nodes.map((node) =>
            node.id === 'welcome' ? { ...node, name: 'Imported while queued' } : node,
          ),
        },
        value: 'imported',
      };
    });
    const eject = controller.finalize(ejectPresentation, (state) => ({
      state: {
        ...state,
        desktop: {
          ...state.desktop,
          lastEjectAt: '2026-07-28T16:00:00.000Z',
        },
      },
      value: 'ejected',
    }));

    await expect(controller.savePresentation(importPresentation)).rejects.toThrow('finalizing');
    releaseImport?.();
    await expect(slowImport).resolves.toMatchObject({ value: 'imported' });
    await expect(eject).resolves.toMatchObject({ value: 'ejected' });

    const loaded = await controller.load();
    expect(loaded.nodes.find((node) => node.id === 'welcome')?.name).toBe('Imported while queued');
    expect(loaded.desktop.trashPosition).toEqual({ x: 410, y: 318 });
    expect(loaded.desktop.lastEjectAt).toBe('2026-07-28T16:00:00.000Z');
    expect(writes).toHaveLength(2);
  });

  it('reopens writes after a finalizing write fails', async () => {
    let failNextWrite = true;
    const controller = createAuthoritativeStateController({
      load: async () => createDefaultState(),
      write: async () => {
        if (!failNextWrite) return;
        failNextWrite = false;
        throw new Error('disk full');
      },
    });
    const presentation = projectPresentation(createDefaultState());

    await expect(
      controller.finalize(presentation, (state) => ({ state, value: null })),
    ).rejects.toThrow('disk full');
    await expect(controller.savePresentation(presentation)).resolves.toBeDefined();
  });
});
