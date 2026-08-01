import type { DocumentPayload } from '../../shared/write';
import { documentPayloadEqual } from '../../shared/write';

export interface WriteSessionState {
  documentId: string | null;
  title: string;
  draft: DocumentPayload;
  saved: DocumentPayload;
  dirty: boolean;
  generation: number;
}

export interface WriteCommittedSnapshot {
  documentId: string | null;
  title: string;
  payload: DocumentPayload;
}

export interface WriteCloseAuthorization {
  token: number;
  generation: number;
  discard: boolean;
}

export const applyWriteDraftPayload = <State extends WriteSessionState>(
  state: State,
  draft: DocumentPayload,
): State => {
  if (documentPayloadEqual(state.draft, draft)) return state;

  return {
    ...state,
    draft,
    dirty: !documentPayloadEqual(draft, state.saved),
    generation: state.generation + 1,
  };
};

export const applyWriteCommittedSnapshot = <State extends WriteSessionState>(
  state: State,
  committed: WriteCommittedSnapshot,
): State => {
  if (state.documentId !== committed.documentId) return state;

  return {
    ...state,
    title: committed.title,
    saved: committed.payload,
    dirty: !documentPayloadEqual(state.draft, committed.payload),
  };
};

export const canFinalizeWriteClose = (
  state: Pick<WriteSessionState, 'dirty' | 'generation'>,
  authorization: WriteCloseAuthorization | undefined,
  token: number,
): boolean =>
  Boolean(
    authorization &&
    authorization.token === token &&
    authorization.generation === state.generation &&
    (!state.dirty || authorization.discard),
  );
