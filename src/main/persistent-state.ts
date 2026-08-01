import { sanitizeState, type MacintoshState } from '../shared/state';

export const MAX_PERSISTENT_STATE_BYTES = 1024 * 1024;

export const serializePersistentState = (state: MacintoshState): string => {
  const serialized = `${JSON.stringify(sanitizeState(state))}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PERSISTENT_STATE_BYTES) {
    throw new RangeError('The Macintosh state exceeds the persistent-state size limit.');
  }
  return serialized;
};

export const parsePersistentState = (serialized: string): MacintoshState => {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PERSISTENT_STATE_BYTES) {
    throw new RangeError('The Macintosh state exceeds the persistent-state size limit.');
  }
  return sanitizeState(JSON.parse(serialized) as unknown);
};
