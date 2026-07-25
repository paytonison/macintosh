export type StateWriter<State> = (state: State) => Promise<void>;

export const createSerializedStateWriter = <State>(
  writeState: StateWriter<State>,
): StateWriter<State> => {
  let queueTail: Promise<void> = Promise.resolve();

  return (state) => {
    const write = queueTail.then(() => writeState(state));
    queueTail = write.catch(() => undefined);
    return write;
  };
};
