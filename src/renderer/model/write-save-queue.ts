export interface VersionedWriteSnapshot<Value> {
  generation: number;
  value: Value;
}

export interface WriteSaveReceipt<Value, Result> {
  snapshot: VersionedWriteSnapshot<Value>;
  result: Result;
}

interface WriteSaveWaiter<Value, Result> {
  generation: number;
  resolve: (receipt: WriteSaveReceipt<Value, Result> | null) => void;
  reject: (error: unknown) => void;
}

interface CreateWriteSaveQueueOptions<Value, Result> {
  initialCommittedGeneration: number;
  capture: () => Promise<VersionedWriteSnapshot<Value>>;
  commit: (snapshot: VersionedWriteSnapshot<Value>) => Promise<Result>;
  onCommitted?: (receipt: WriteSaveReceipt<Value, Result>) => void;
}

export interface WriteSaveQueue<Value, Result> {
  request: (generation: number) => Promise<WriteSaveReceipt<Value, Result> | null>;
  committedGeneration: () => number;
  saving: () => boolean;
}

export const createWriteSaveQueue = <Value, Result>({
  initialCommittedGeneration,
  capture,
  commit,
  onCommitted,
}: CreateWriteSaveQueueOptions<Value, Result>): WriteSaveQueue<Value, Result> => {
  let committedGeneration = initialCommittedGeneration;
  let requestedGeneration = initialCommittedGeneration;
  let running: Promise<void> | null = null;
  let waiters: WriteSaveWaiter<Value, Result>[] = [];
  let lastReceipt: WriteSaveReceipt<Value, Result> | null = null;

  const resolveCommitted = (): void => {
    const remaining: WriteSaveWaiter<Value, Result>[] = [];
    for (const waiter of waiters) {
      if (waiter.generation <= committedGeneration) waiter.resolve(lastReceipt);
      else remaining.push(waiter);
    }
    waiters = remaining;
  };

  const rejectPending = (error: unknown): void => {
    const pending = waiters;
    waiters = [];
    requestedGeneration = committedGeneration;
    for (const waiter of pending) waiter.reject(error);
  };

  const drain = async (): Promise<void> => {
    try {
      while (requestedGeneration > committedGeneration) {
        const requestedAtCapture = requestedGeneration;
        const snapshot = await capture();
        if (snapshot.generation < requestedAtCapture) {
          throw new Error('The captured Write snapshot is older than the requested generation.');
        }
        const result = await commit(snapshot);
        const receipt = { snapshot, result } satisfies WriteSaveReceipt<Value, Result>;
        committedGeneration = Math.max(committedGeneration, snapshot.generation);
        lastReceipt = receipt;
        onCommitted?.(receipt);
        resolveCommitted();
      }
    } catch (error) {
      rejectPending(error);
    } finally {
      running = null;
    }
  };

  const request = (generation: number): Promise<WriteSaveReceipt<Value, Result> | null> => {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      return Promise.reject(new TypeError('Write save generations must be non-negative integers.'));
    }
    if (generation <= committedGeneration) return Promise.resolve(lastReceipt);

    requestedGeneration = Math.max(requestedGeneration, generation);
    const result = new Promise<WriteSaveReceipt<Value, Result> | null>((resolve, reject) => {
      waiters.push({ generation, resolve, reject });
    });
    running ??= drain();
    return result;
  };

  return {
    request,
    committedGeneration: () => committedGeneration,
    saving: () => running !== null,
  };
};
