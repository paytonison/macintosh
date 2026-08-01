import { describe, expect, it } from 'vitest';

import {
  WRITE_PAGE_PRESET,
  createDefaultWriteParagraphStyle,
  type DocumentPayload,
} from '../../shared/write';
import {
  applyWriteCommittedSnapshot,
  applyWriteDraftPayload,
  canFinalizeWriteClose,
  type WriteSessionState,
} from './write-session-state';

const plain = (text: string): DocumentPayload => ({ format: 'plain-text', text });

const session = (
  overrides: Partial<WriteSessionState> = {},
): WriteSessionState & { windowMarker: string } => {
  const saved = plain('saved');
  return {
    documentId: 'document-a',
    title: 'Draft',
    draft: saved,
    saved,
    dirty: false,
    generation: 0,
    windowMarker: 'preserved',
    ...overrides,
  };
};

describe('Write window session state', () => {
  it('returns the same state object when an equal draft payload arrives', () => {
    const state = session({ draft: plain('same'), saved: plain('same'), generation: 7 });

    const next = applyWriteDraftPayload(state, plain('same'));

    expect(next).toBe(state);
    expect(next.generation).toBe(7);
  });

  it('applies a changed draft and advances its generation exactly once', () => {
    const state = session({ generation: 7 });
    const draft = plain('changed');

    const next = applyWriteDraftPayload(state, draft);

    expect(next).not.toBe(state);
    expect(next).toMatchObject({
      draft,
      dirty: true,
      generation: 8,
      windowMarker: 'preserved',
    });
    expect(state.generation).toBe(7);
  });

  it('counts Undo back to the saved payload as a change while returning to clean', () => {
    const saved = plain('saved');
    const state = session({
      draft: plain('edited'),
      saved,
      dirty: true,
      generation: 4,
    });

    const next = applyWriteDraftPayload(state, plain('saved'));

    expect(next.generation).toBe(5);
    expect(next.dirty).toBe(false);
    expect(next.draft).toEqual(saved);
  });

  it('keeps a newer draft dirty when an older committed snapshot arrives', () => {
    const newerDraft = plain('edited during save');
    const submitted = plain('submitted');
    const state = session({
      draft: newerDraft,
      saved: plain('older'),
      dirty: true,
      generation: 3,
    });

    const next = applyWriteCommittedSnapshot(state, {
      documentId: 'document-a',
      title: 'Saved Draft',
      payload: submitted,
    });

    expect(next).toMatchObject({
      title: 'Saved Draft',
      draft: newerDraft,
      saved: submitted,
      dirty: true,
      generation: 3,
    });
    expect(next.draft).toBe(newerDraft);
  });

  it('marks the session clean when the current draft is committed', () => {
    const currentDraft = plain('current');
    const state = session({
      draft: currentDraft,
      saved: plain('older'),
      dirty: true,
      generation: 5,
    });

    const next = applyWriteCommittedSnapshot(state, {
      documentId: 'document-a',
      title: 'Current Draft',
      payload: currentDraft,
    });

    expect(next).toMatchObject({
      title: 'Current Draft',
      draft: currentDraft,
      saved: currentDraft,
      dirty: false,
      generation: 5,
    });
    expect(next.draft).toBe(currentDraft);
  });

  it('ignores a committed snapshot for a stale document binding', () => {
    const state = session({ documentId: 'document-b', generation: 9 });

    const next = applyWriteCommittedSnapshot(state, {
      documentId: 'document-a',
      title: 'Stale Save',
      payload: plain('stale'),
    });

    expect(next).toBe(state);
  });

  it('preserves rich payloads and explicit serif formatting exactly', () => {
    const serif: DocumentPayload = {
      format: 'write-v1',
      pagePreset: WRITE_PAGE_PRESET,
      blocks: [
        {
          type: 'paragraph',
          style: {
            ...createDefaultWriteParagraphStyle(),
            firstLineIndent: 24,
            tabStops: [48, 144],
          },
          content: [
            {
              type: 'text',
              text: 'Exact serif',
              marks: [{ type: 'italic' }, { type: 'font-family-serif' }, { type: 'font-size-18' }],
            },
          ],
        },
      ],
    };
    const edited = applyWriteDraftPayload(session(), serif);

    expect(edited.draft).toBe(serif);
    expect(edited.draft).toEqual(serif);

    const committed = applyWriteCommittedSnapshot(edited, {
      documentId: 'document-a',
      title: 'Serif Draft',
      payload: serif,
    });

    expect(committed.saved).toBe(serif);
    expect(committed.draft).toBe(serif);
    expect(committed.dirty).toBe(false);
    expect(committed.generation).toBe(1);
  });
});

describe('Write close authorization', () => {
  const clean = { dirty: false, generation: 4 };
  const dirty = { dirty: true, generation: 4 };
  const ordinary = { token: 7, generation: 4, discard: false };
  const discard = { token: 7, generation: 4, discard: true };

  it('finalizes a matching clean close and an explicitly discarded dirty generation', () => {
    expect(canFinalizeWriteClose(clean, ordinary, 7)).toBe(true);
    expect(canFinalizeWriteClose(dirty, discard, 7)).toBe(true);
  });

  it('refuses an unauthorized dirty close or any stale token or generation', () => {
    expect(canFinalizeWriteClose(dirty, ordinary, 7)).toBe(false);
    expect(canFinalizeWriteClose(clean, undefined, 7)).toBe(false);
    expect(canFinalizeWriteClose(clean, ordinary, 8)).toBe(false);
    expect(canFinalizeWriteClose({ ...dirty, generation: 5 }, discard, 7)).toBe(false);
  });
});
