import { useCallback, useEffect, useRef } from 'react';

import type { DocumentPayload } from '../../shared/write';
import type { WindowGeometry } from '../../shared/state';
import {
  ClassicWindowAnimationShadow,
  ClassicWindowFrame,
  type ClassicWindowAnimation,
} from './ClassicWindowFrame';
import {
  WriteEditor,
  type WriteEditorCommand,
  type WriteEditorContext,
  type WriteEditorHandle,
} from './WriteEditor';
import { WriteRuler } from './WriteRuler';

export interface WriteWindowState extends WindowGeometry {
  id: string;
  documentId: string | null;
  title: string;
  draft: DocumentPayload;
  saved: DocumentPayload;
  generation: number;
  dirty: boolean;
  zoom: 50 | 75 | 100;
  pageNumber: number;
  pageCount: number;
}

export type WriteWindowAnimation = ClassicWindowAnimation;

interface WriteWindowAnimationShadowProps {
  animation: WriteWindowAnimation;
  stackIndex: number;
  windowState: WriteWindowState;
}

interface WriteWindowProps {
  windowState: WriteWindowState;
  active: boolean;
  stackIndex: number;
  animation?: WriteWindowAnimation;
  context: WriteEditorContext;
  editorEnabled: boolean;
  layoutError: string | null;
  interactionCancelToken: number;
  onActivate: (id: string) => void;
  onAnimationComplete?: (id: string, phase: WriteWindowAnimation['phase'], token: number) => void;
  onClose: (id: string) => void;
  onDraftChange: (id: string, payload: DocumentPayload) => void;
  onEditorContext: (id: string, context: WriteEditorContext) => void;
  onEditorRegistration: (id: string, editor: WriteEditorHandle | null) => void;
  onGeometry: (id: string, geometry: WindowGeometry) => void;
  onInteractionChange: (active: boolean) => void;
  onLayoutError: (id: string, message: string | null) => void;
  onPaginationChange: (id: string, pageNumber: number, pageCount: number) => void;
  onZoom: (id: string) => void;
}

export function WriteWindowAnimationShadow({
  animation,
  stackIndex,
  windowState,
}: WriteWindowAnimationShadowProps) {
  return (
    <ClassicWindowAnimationShadow
      animation={animation}
      geometry={windowState}
      windowId={windowState.id}
      zIndex={300 + stackIndex}
    />
  );
}

export function WriteWindow({
  windowState,
  active,
  stackIndex,
  animation,
  context,
  editorEnabled,
  layoutError,
  interactionCancelToken,
  onActivate,
  onAnimationComplete,
  onClose,
  onDraftChange,
  onEditorContext,
  onEditorRegistration,
  onGeometry,
  onInteractionChange,
  onLayoutError,
  onPaginationChange,
  onZoom,
}: WriteWindowProps) {
  const editorHandle = useRef<WriteEditorHandle | null>(null);
  const editorRegistration = useCallback(
    (editor: WriteEditorHandle | null) => {
      editorHandle.current = editor;
      onEditorRegistration(windowState.id, editor);
    },
    [onEditorRegistration, windowState.id],
  );

  useEffect(
    () => () => {
      onEditorRegistration(windowState.id, null);
    },
    [onEditorRegistration, windowState.id],
  );

  return (
    <ClassicWindowFrame
      active={active}
      animation={animation}
      ariaLabel={`${windowState.title} — Write window`}
      className="write-window"
      controlLabel={windowState.title}
      dataAttributes={{
        'data-document-format': windowState.draft.format,
        'data-document-id': windowState.documentId ?? '',
        'data-write-title': windowState.title,
        'data-write-window': windowState.id,
      }}
      geometry={windowState}
      growBoxClassName="write-grow-box"
      interactionCancelToken={interactionCancelToken}
      minimumHeight={360}
      minimumWidth={520}
      onActivate={onActivate}
      onAnimationComplete={onAnimationComplete}
      onClose={onClose}
      onGeometry={onGeometry}
      onInteractionChange={onInteractionChange}
      onZoom={onZoom}
      title={
        <>
          {windowState.title}
          {windowState.dirty ? ' •' : ''} — Write
        </>
      }
      titleBarClassName="write-titlebar"
      windowId={windowState.id}
      zIndex={300 + stackIndex}
    >
      {({ growBox }) => (
        <>
          <div className="write-ruler-bar" onPointerDownCapture={() => onActivate(windowState.id)}>
            <WriteRuler
              disabled={!context.canFormat}
              interactionCancelToken={interactionCancelToken}
              onCommand={(command: WriteEditorCommand) => editorHandle.current?.execute(command)}
              onInteractionChange={onInteractionChange}
              style={context.style}
              zoom={windowState.zoom}
            />
          </div>
          <div className="write-document-viewport" onPointerDown={() => onActivate(windowState.id)}>
            <WriteEditor
              active={editorEnabled}
              editorRef={editorRegistration}
              onChange={(payload) => onDraftChange(windowState.id, payload)}
              onContextChange={(next) => onEditorContext(windowState.id, next)}
              onLayoutError={(message) => onLayoutError(windowState.id, message)}
              onPaginationChange={(pageNumber, pageCount) =>
                onPaginationChange(windowState.id, pageNumber, pageCount)
              }
              payload={windowState.draft}
              zoom={windowState.zoom}
            />
          </div>
          <footer className="write-status-bar">
            <span role={layoutError ? 'alert' : undefined}>
              {layoutError ?? `Page ${windowState.pageNumber} of ${windowState.pageCount}`}
            </span>
            <span>{windowState.zoom}%</span>
          </footer>
          {growBox}
        </>
      )}
    </ClassicWindowFrame>
  );
}
