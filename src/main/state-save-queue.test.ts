import { describe, expect, it, vi } from 'vitest';

import { createSerializedStateWriter } from './state-save-queue';

describe('serialized state writer', () => {
  it('continues with later writes after a failed write', async () => {
    const writeState = vi
      .fn<(state: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const saveState = createSerializedStateWriter(writeState);

    await expect(saveState('first')).rejects.toThrow('disk full');
    await expect(saveState('second')).resolves.toBeUndefined();

    expect(writeState).toHaveBeenNthCalledWith(1, 'first');
    expect(writeState).toHaveBeenNthCalledWith(2, 'second');
  });

  it('starts each write only after the previous write settles', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: string[] = [];
    const saveState = createSerializedStateWriter(async (state: string) => {
      writes.push(state);
      if (state === 'first') await firstWrite;
    });

    const first = saveState('first');
    const second = saveState('second');
    await Promise.resolve();

    expect(writes).toEqual(['first']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(writes).toEqual(['first', 'second']);
  });
});
