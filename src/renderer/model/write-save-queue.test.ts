import { describe, expect, it, vi } from 'vitest';

import { createWriteSaveQueue, type VersionedWriteSnapshot } from './write-save-queue';

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('Write save queue', () => {
  it('commits a captured generation newer than the requested generation', async () => {
    const snapshot = { generation: 3, value: 'newest draft' };
    const commit = vi.fn(async () => 'saved');
    const queue = createWriteSaveQueue({
      initialCommittedGeneration: 0,
      capture: async () => snapshot,
      commit,
    });

    await expect(queue.request(1)).resolves.toEqual({ snapshot, result: 'saved' });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(snapshot);
    expect(queue.committedGeneration()).toBe(3);
    expect(queue.saving()).toBe(false);
  });

  it('rejects a captured generation older than the request without committing it', async () => {
    const commit = vi.fn(async () => 'should not save');
    const queue = createWriteSaveQueue({
      initialCommittedGeneration: 0,
      capture: async () => ({ generation: 1, value: 'stale draft' }),
      commit,
    });

    await expect(queue.request(2)).rejects.toThrow(
      'The captured Write snapshot is older than the requested generation.',
    );
    expect(commit).not.toHaveBeenCalled();
    expect(queue.committedGeneration()).toBe(0);
    expect(queue.saving()).toBe(false);
  });

  it('coalesces repeated requests for one generation into one commit', async () => {
    const snapshot = { generation: 1, value: 'draft' };
    const gate = deferred<string>();
    const capture = vi.fn(async () => snapshot);
    const commit = vi.fn(async () => gate.promise);
    const queue = createWriteSaveQueue({ initialCommittedGeneration: 0, capture, commit });

    const first = queue.request(1);
    const second = queue.request(1);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(queue.saving()).toBe(true);

    gate.resolve('saved');
    await expect(first).resolves.toEqual({ snapshot, result: 'saved' });
    await expect(second).resolves.toEqual({ snapshot, result: 'saved' });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(queue.committedGeneration()).toBe(1);
    expect(queue.saving()).toBe(false);
  });

  it('queues only the newest generation requested during an in-flight commit', async () => {
    let current: VersionedWriteSnapshot<string> = { generation: 1, value: 'first' };
    const firstGate = deferred<string>();
    const capture = vi.fn(async () => current);
    const commit = vi
      .fn<(snapshot: VersionedWriteSnapshot<string>) => Promise<string>>()
      .mockImplementationOnce(async () => firstGate.promise)
      .mockImplementationOnce(async (snapshot) => `saved ${snapshot.value}`);
    const queue = createWriteSaveQueue({ initialCommittedGeneration: 0, capture, commit });

    const first = queue.request(1);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    current = { generation: 3, value: 'newest' };
    const second = queue.request(2);
    const third = queue.request(3);
    firstGate.resolve('saved first');

    await expect(first).resolves.toMatchObject({ snapshot: { generation: 1 } });
    await expect(second).resolves.toMatchObject({
      snapshot: { generation: 3 },
      result: 'saved newest',
    });
    await expect(third).resolves.toMatchObject({
      snapshot: { generation: 3 },
      result: 'saved newest',
    });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(queue.committedGeneration()).toBe(3);
  });

  it('clears failed pending requests and allows a later retry', async () => {
    const snapshot = { generation: 1, value: 'recoverable' };
    const commit = vi
      .fn<(value: VersionedWriteSnapshot<string>) => Promise<string>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce('saved');
    const queue = createWriteSaveQueue({
      initialCommittedGeneration: 0,
      capture: async () => snapshot,
      commit,
    });

    await expect(queue.request(1)).rejects.toThrow('disk full');
    expect(queue.committedGeneration()).toBe(0);
    expect(queue.saving()).toBe(false);
    await expect(queue.request(1)).resolves.toMatchObject({ result: 'saved' });
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('rejects every pending waiter after a failure and permits a same-generation retry', async () => {
    const snapshot = { generation: 1, value: 'recoverable' };
    const gate = deferred<string>();
    const commit = vi
      .fn<(value: VersionedWriteSnapshot<string>) => Promise<string>>()
      .mockImplementationOnce(async () => gate.promise)
      .mockResolvedValueOnce('saved');
    const queue = createWriteSaveQueue({
      initialCommittedGeneration: 0,
      capture: async () => snapshot,
      commit,
    });

    const first = queue.request(1);
    const second = queue.request(1);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    gate.reject(new Error('disk full'));

    await expect(first).rejects.toThrow('disk full');
    await expect(second).rejects.toThrow('disk full');
    expect(queue.committedGeneration()).toBe(0);
    expect(queue.saving()).toBe(false);

    await expect(queue.request(1)).resolves.toEqual({ snapshot, result: 'saved' });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(queue.committedGeneration()).toBe(1);
  });

  it('drains a request issued by onCommitted before reporting that saving finished', async () => {
    let current: VersionedWriteSnapshot<string> = { generation: 1, value: 'first' };
    let followup: Promise<unknown> | null = null;
    const savingDuringCommit: boolean[] = [];
    const commit = vi.fn(
      async (snapshot: VersionedWriteSnapshot<string>) => `saved ${snapshot.value}`,
    );
    const queue = createWriteSaveQueue({
      initialCommittedGeneration: 0,
      capture: async () => current,
      commit,
      onCommitted: ({ snapshot }) => {
        savingDuringCommit.push(queue.saving());
        if (snapshot.generation === 1) {
          current = { generation: 2, value: 'second' };
          followup = queue.request(2);
        }
      },
    });

    await expect(queue.request(1)).resolves.toMatchObject({ snapshot: { generation: 1 } });
    expect(followup).not.toBeNull();
    await expect(followup).resolves.toMatchObject({ snapshot: { generation: 2 } });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(savingDuringCommit).toEqual([true, true]);
    expect(queue.committedGeneration()).toBe(2);
    expect(queue.saving()).toBe(false);
  });

  it('reports saving false after synchronous capture and commit promises settle', async () => {
    const snapshot = { generation: 1, value: 'draft' };
    const capture = vi.fn(() => Promise.resolve(snapshot));
    const commit = vi.fn(() => Promise.resolve('saved'));
    const queue = createWriteSaveQueue({ initialCommittedGeneration: 0, capture, commit });

    expect(queue.saving()).toBe(false);
    const save = queue.request(1);
    expect(queue.saving()).toBe(true);
    await expect(save).resolves.toEqual({ snapshot, result: 'saved' });
    expect(queue.saving()).toBe(false);
  });

  it('keeps queues for different windows independent', async () => {
    const firstGate = deferred<string>();
    const first = createWriteSaveQueue({
      initialCommittedGeneration: 0,
      capture: async () => ({ generation: 1, value: 'first' }),
      commit: async () => firstGate.promise,
    });
    const second = createWriteSaveQueue({
      initialCommittedGeneration: 0,
      capture: async () => ({ generation: 1, value: 'second' }),
      commit: async () => 'second saved',
    });

    const firstSave = first.request(1);
    await expect(second.request(1)).resolves.toMatchObject({ result: 'second saved' });
    expect(first.saving()).toBe(true);
    firstGate.resolve('first saved');
    await expect(firstSave).resolves.toMatchObject({ result: 'first saved' });
  });
});
