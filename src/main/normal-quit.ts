export interface NormalQuitCoordinatorOptions<State> {
  requestRendererFlush: () => void;
  persistFinalState: (state: State | null) => Promise<void>;
  quitApplication: () => void;
}

export interface NormalQuitCoordinator<State> {
  requestQuit: () => void;
  rendererReady: () => void;
  flushAndQuit: (state: State | null) => Promise<void>;
  finalizeAndQuitWithoutRenderer: () => Promise<void>;
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
  let rendererIsReady = false;

  const requestFlushFromRenderer = (): void => {
    try {
      requestRendererFlush();
    } catch (error) {
      phase = 'idle';
      throw error;
    }
  };

  const requestQuit = (): void => {
    if (phase === 'approved') {
      quitApplication();
      return;
    }
    if (phase === 'flushing') return;

    if (phase === 'idle') phase = 'requested';
    if (rendererIsReady) requestFlushFromRenderer();
  };

  const rendererReady = (): void => {
    rendererIsReady = true;
    if (phase === 'requested') requestFlushFromRenderer();
  };

  const persistAndQuit = (state: State | null): Promise<void> => {
    if (phase === 'approved') return Promise.resolve();
    if (flushPromise) return flushPromise;

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

  const flushAndQuit = (state: State | null): Promise<void> => {
    if (phase !== 'requested' && !flushPromise && phase !== 'approved') {
      return Promise.reject(new Error('Normal quit was not requested.'));
    }
    return persistAndQuit(state);
  };

  const finalizeAndQuitWithoutRenderer = (): Promise<void> => persistAndQuit(null);

  const quitWithoutFlush = (): void => {
    phase = 'approved';
    quitApplication();
  };

  return {
    requestQuit,
    rendererReady,
    flushAndQuit,
    finalizeAndQuitWithoutRenderer,
    quitWithoutFlush,
    shouldPreventQuit: () => phase !== 'approved',
  };
};
