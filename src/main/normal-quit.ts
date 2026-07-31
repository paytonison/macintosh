export interface NormalQuitCoordinatorOptions<State> {
  requestRendererFlush: () => void;
  persistFinalState: (state: State | null) => Promise<void>;
  quitApplication: () => void;
}

export interface NormalQuitCoordinator<State> {
  requestQuit: () => void;
  flushAndQuit: (state: State | null) => Promise<void>;
  quitWithoutFlush: () => void;
  shouldPreventQuit: () => boolean;
}

type NormalQuitPhase = 'idle' | 'requested' | 'flushing' | 'approved';

export const createNormalQuitCoordinator = <State>({
  requestRendererFlush,
  persistFinalState,
  quitApplication,
}: NormalQuitCoordinatorOptions<State>): NormalQuitCoordinator<State> => {
  let phase: NormalQuitPhase = 'idle';
  let flushPromise: Promise<void> | null = null;

  const requestQuit = (): void => {
    if (phase === 'approved') {
      quitApplication();
      return;
    }
    if (phase !== 'idle') return;

    phase = 'requested';
    try {
      requestRendererFlush();
    } catch (error) {
      phase = 'idle';
      throw error;
    }
  };

  const flushAndQuit = (state: State | null): Promise<void> => {
    if (phase === 'approved') return Promise.resolve();
    if (flushPromise) return flushPromise;
    if (phase !== 'requested') {
      return Promise.reject(new Error('Normal quit was not requested.'));
    }

    phase = 'flushing';
    const operation = persistFinalState(state)
      .then(() => {
        phase = 'approved';
        quitApplication();
      })
      .catch((error: unknown) => {
        phase = 'idle';
        throw error;
      })
      .finally(() => {
        if (flushPromise === operation) flushPromise = null;
      });
    flushPromise = operation;
    return operation;
  };

  const quitWithoutFlush = (): void => {
    phase = 'approved';
    quitApplication();
  };

  return {
    requestQuit,
    flushAndQuit,
    quitWithoutFlush,
    shouldPreventQuit: () => phase !== 'approved',
  };
};
