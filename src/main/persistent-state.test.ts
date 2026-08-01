import { describe, expect, it } from 'vitest';

import { createDefaultState, type VfsNode } from '../shared/state';
import { createDefaultWriteParagraphStyle, type DocumentPayload } from '../shared/write';
import { executeVfsCommand } from '../shared/vfs';
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

const exactRichPayload = (): DocumentPayload => ({
  format: 'write-v1',
  pagePreset: 'us-letter-1in',
  blocks: [
    {
      type: 'paragraph',
      style: {
        ...createDefaultWriteParagraphStyle(),
        alignment: 'right',
        leftIndent: 24,
        firstLineIndent: 12,
        rightIndent: 36,
        tabStops: [72, 144],
        lineSpacing: 2,
      },
      content: [
        {
          type: 'text',
          text: 'Preserve',
          marks: [
            { type: 'bold' },
            { type: 'italic' },
            { type: 'font-family-serif' },
            { type: 'font-size-18' },
          ],
        },
        { type: 'tab' },
        {
          type: 'text',
          text: 'everything',
          marks: [{ type: 'underline' }, { type: 'font-family-serif' }, { type: 'font-size-18' }],
        },
      ],
    },
    { type: 'page-break' },
    {
      type: 'paragraph',
      style: createDefaultWriteParagraphStyle(),
      content: [{ type: 'text', text: 'After the break' }],
    },
  ],
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

  it('preserves an exact rich duplicate across Trash moves and repeated relaunches', () => {
    const state = createDefaultState();
    const source = state.nodes.find((node) => node.id === 'read-me');
    if (!source) throw new Error('Missing rich persistence fixture.');
    source.payload = exactRichPayload();

    const duplicated = executeVfsCommand(
      state,
      { type: 'duplicate-nodes', nodeIds: [source.id], parentId: 'documents' },
      '2026-07-22T12:00:00.000Z',
    );
    const copyId = duplicated.affectedIds[0];
    if (!copyId) throw new Error('Rich persistence fixture was not duplicated.');

    const trashed = executeVfsCommand(
      duplicated.state,
      { type: 'move-nodes', nodeIds: [copyId], parentId: 'trash' },
      '2026-07-22T12:01:00.000Z',
    );
    const relaunchedInTrash = parsePersistentState(serializePersistentState(trashed.state));
    expect(relaunchedInTrash.nodes.find((node) => node.id === copyId)).toMatchObject({
      parentId: 'trash',
      payload: exactRichPayload(),
    });
    expect(relaunchedInTrash.nodes.find((node) => node.id === source.id)?.payload).toEqual(
      exactRichPayload(),
    );

    const restored = executeVfsCommand(
      relaunchedInTrash,
      { type: 'move-nodes', nodeIds: [copyId], parentId: 'documents' },
      '2026-07-22T12:02:00.000Z',
    );
    const relaunchedRestored = parsePersistentState(serializePersistentState(restored.state));
    expect(relaunchedRestored.nodes.find((node) => node.id === copyId)).toMatchObject({
      parentId: 'documents',
      payload: exactRichPayload(),
    });
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
