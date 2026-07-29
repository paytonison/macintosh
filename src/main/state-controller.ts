import { mergePresentation } from '../shared/presentation';
import { sanitizeState, type MacintoshState } from '../shared/state';

export interface StateTransition<T> {
  state: MacintoshState;
  value: T;
}

export interface AuthoritativeStateController {
  load: () => Promise<MacintoshState>;
  savePresentation: (patch: unknown) => Promise<MacintoshState>;
  transact: <T>(
    patch: unknown,
    transition: (state: MacintoshState) => StateTransition<T> | Promise<StateTransition<T>>,
  ) => Promise<StateTransition<T>>;
  finalize: <T>(
    patch: unknown,
    transition: (state: MacintoshState) => StateTransition<T> | Promise<StateTransition<T>>,
  ) => Promise<StateTransition<T>>;
}

interface StateControllerOptions {
  load: () => Promise<MacintoshState>;
  write: (state: MacintoshState) => Promise<void>;
}

export const createAuthoritativeStateController = ({
  load,
  write,
}: StateControllerOptions): AuthoritativeStateController => {
  let current: MacintoshState | null = null;
  let queueTail = Promise.resolve();
  let finalizing = false;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = queueTail.then(operation);
    queueTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const loadCurrent = async (): Promise<MacintoshState> => {
    if (current) return current;
    current = sanitizeState(await load());
    return current;
  };

  const rejectIfFinalizing = (): void => {
    if (finalizing) throw new Error('The authoritative state is finalizing.');
  };

  const transitionState = async <T>(
    patch: unknown,
    transition: (state: MacintoshState) => StateTransition<T> | Promise<StateTransition<T>>,
  ): Promise<StateTransition<T>> => {
    const previous = await loadCurrent();
    const base = mergePresentation(previous, patch);
    const transitioned = await transition(base);
    const next = sanitizeState(transitioned.state);
    await write(next);
    current = next;
    return { state: next, value: transitioned.value };
  };

  return {
    load: () => enqueue(loadCurrent),

    savePresentation: (patch) => {
      try {
        rejectIfFinalizing();
      } catch (error) {
        return Promise.reject(error as Error);
      }
      return enqueue(async () => {
        const previous = await loadCurrent();
        const next = mergePresentation(previous, patch);
        await write(next);
        current = next;
        return next;
      });
    },

    transact: (patch, transition) => {
      try {
        rejectIfFinalizing();
      } catch (error) {
        return Promise.reject(error as Error);
      }
      return enqueue(() => transitionState(patch, transition));
    },

    finalize: (patch, transition) => {
      try {
        rejectIfFinalizing();
      } catch (error) {
        return Promise.reject(error as Error);
      }
      finalizing = true;
      return enqueue(() => transitionState(patch, transition)).catch((error: unknown) => {
        finalizing = false;
        throw error;
      });
    },
  };
};
