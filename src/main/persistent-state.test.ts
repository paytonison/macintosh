import { describe, expect, it } from 'vitest';

import { createDefaultState, type VfsNode } from '../shared/state';
import { createDefaultWriteParagraphStyle } from '../shared/write';
import {
  MAX_PERSISTENT_STATE_BYTES,
  parsePersistentState,
  serializePersistentState,
} from './persistent-state';

const largeRichDocument = (id: string): VfsNode => ({
  id,
  parentId: 'documents',
  name: id,
  kind: 'document',
  payload: {
    format: 'write-v1',
    pagePreset: 'us-letter-1in',
    blocks: Array.from({ length: 2_048 }, () => ({
      type: 'paragraph' as const,
      style: createDefaultWriteParagraphStyle(),
      content: [{ type: 'text' as const, text: 'x' }],
    })),
  },
  createdAt: '1984-01-24T00:00:00.000Z',
  modifiedAt: '1984-01-24T00:00:00.000Z',
});

describe('persistent Macintosh state encoding', () => {
  it('uses a compact bounded representation that survives a rich-document relaunch', () => {
    const state = createDefaultState();
    state.nodes.push(largeRichDocument('large-rich'));

    const serialized = serializePersistentState(state);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MAX_PERSISTENT_STATE_BYTES);
    expect(parsePersistentState(serialized).nodes.find((node) => node.id === 'large-rich')).toEqual(
      state.nodes.at(-1),
    );
  });

  it('rejects a whole-state transition that cannot be loaded again', () => {
    const state = createDefaultState();
    state.nodes.push(
      largeRichDocument('large-rich-1'),
      largeRichDocument('large-rich-2'),
      largeRichDocument('large-rich-3'),
    );

    expect(() => serializePersistentState(state)).toThrow(/size limit/);
    expect(() => parsePersistentState('x'.repeat(MAX_PERSISTENT_STATE_BYTES + 1))).toThrow(
      /size limit/,
    );
  });
});
