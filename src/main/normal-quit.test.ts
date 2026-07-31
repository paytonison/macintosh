import { describe, expect, it, vi } from 'vitest';

import { createNormalQuitCoordinator } from './normal-quit';

const deferred = () => {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: () => resolve?.(),
    reject: (error: Error) => reject?.(error),
  };
};

describe('normal quit coordinator', () => {
  it('coalesces repeated quit and flush requests into one final save', async () => {
    const write = deferred();
    const requestRendererFlush = vi.fn();
    const persistFinalState = vi.fn(() => write.promise);
    const quitApplication = vi.fn();
    const coordinator = createNormalQuitCoordinator({
      requestRendererFlush,
      persistFinalState,
      quitApplication,
    });

    coordinator.requestQuit();
    coordinator.requestQuit();
    const firstFlush = coordinator.flushAndQuit('latest');
    const secondFlush = coordinator.flushAndQuit('ignored');

    expect(requestRendererFlush).toHaveBeenCalledTimes(1);
    expect(persistFinalState).toHaveBeenCalledTimes(1);
    expect(persistFinalState).toHaveBeenCalledWith('latest');
    expect(firstFlush).toBe(secondFlush);
    expect(coordinator.shouldPreventQuit()).toBe(true);
    expect(quitApplication).not.toHaveBeenCalled();

    write.resolve();
    await firstFlush;

    expect(coordinator.shouldPreventQuit()).toBe(false);
    expect(quitApplication).toHaveBeenCalledTimes(1);
  });

  it('keeps the application open after a failed save and allows a retry', async () => {
    const requestRendererFlush = vi.fn();
    const persistFinalState = vi
      .fn<(state: string | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const quitApplication = vi.fn();
    const coordinator = createNormalQuitCoordinator({
      requestRendererFlush,
      persistFinalState,
      quitApplication,
    });

    coordinator.requestQuit();
    await expect(coordinator.flushAndQuit('first')).rejects.toThrow('disk full');

    expect(coordinator.shouldPreventQuit()).toBe(true);
    expect(quitApplication).not.toHaveBeenCalled();

    coordinator.requestQuit();
    await expect(coordinator.flushAndQuit('second')).resolves.toBeUndefined();

    expect(requestRendererFlush).toHaveBeenCalledTimes(2);
    expect(persistFinalState).toHaveBeenNthCalledWith(2, 'second');
    expect(quitApplication).toHaveBeenCalledTimes(1);
  });

  it('rejects unsolicited renderer flushes', async () => {
    const coordinator = createNormalQuitCoordinator<string>({
      requestRendererFlush: vi.fn(),
      persistFinalState: vi.fn().mockResolvedValue(undefined),
      quitApplication: vi.fn(),
    });

    await expect(coordinator.flushAndQuit('state')).rejects.toThrow(
      'Normal quit was not requested.',
    );
  });

  it('keeps forced and automation shutdown distinct from normal persistence', () => {
    const persistFinalState = vi.fn().mockResolvedValue(undefined);
    const quitApplication = vi.fn();
    const coordinator = createNormalQuitCoordinator<string>({
      requestRendererFlush: vi.fn(),
      persistFinalState,
      quitApplication,
    });

    coordinator.quitWithoutFlush();

    expect(coordinator.shouldPreventQuit()).toBe(false);
    expect(persistFinalState).not.toHaveBeenCalled();
    expect(quitApplication).toHaveBeenCalledTimes(1);
  });
});
