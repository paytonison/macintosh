import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { DocumentPayload } from '../../shared/write';
import type { WindowGeometry } from '../../shared/state';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from '../model/pointer-drag';
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
  dirty: boolean;
  zoom: 50 | 75 | 100;
  pageNumber: number;
  pageCount: number;
}

interface GeometrySession {
  pointerId: number;
  target: HTMLElement;
  original: WindowGeometry;
  current: WindowGeometry;
  intent: PointerDragIntent;
}

interface WriteWindowProps {
  windowState: WriteWindowState;
  active: boolean;
  stackIndex: number;
  context: WriteEditorContext;
  interactionCancelToken: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onDraftChange: (id: string, payload: DocumentPayload) => void;
  onEditorContext: (id: string, context: WriteEditorContext) => void;
  onEditorRegistration: (id: string, editor: WriteEditorHandle | null) => void;
  onGeometry: (id: string, geometry: WindowGeometry) => void;
  onInteractionChange: (active: boolean) => void;
  onPaginationChange: (id: string, pageNumber: number, pageCount: number) => void;
  onZoom: (id: string) => void;
}

export function WriteWindow({
  windowState,
  active,
  stackIndex,
  context,
  interactionCancelToken,
  onActivate,
  onClose,
  onDraftChange,
  onEditorContext,
  onEditorRegistration,
  onGeometry,
  onInteractionChange,
  onPaginationChange,
  onZoom,
}: WriteWindowProps) {
  const drag = useRef<GeometrySession | null>(null);
  const resize = useRef<GeometrySession | null>(null);
  const editorHandle = useRef<WriteEditorHandle | null>(null);
  const editorRegistration = useCallback(
    (editor: WriteEditorHandle | null) => {
      editorHandle.current = editor;
      onEditorRegistration(windowState.id, editor);
    },
    [onEditorRegistration, windowState.id],
  );

  const finishMove = (pointerId: number, commit: boolean): void => {
    const session = drag.current;
    if (!session || session.pointerId !== pointerId) return;
    drag.current = null;
    if (session.target.hasPointerCapture(pointerId))
      session.target.releasePointerCapture(pointerId);
    onInteractionChange(false);
    if (commit && releasePointerDrag(session.intent) === 'drag') {
      onGeometry(windowState.id, session.current);
    }
  };

  useLayoutEffect(() => {
    for (const session of [drag.current, resize.current]) {
      if (session?.target.hasPointerCapture(session.pointerId)) {
        session.target.releasePointerCapture(session.pointerId);
      }
    }
    drag.current = null;
    resize.current = null;
    onInteractionChange(false);
  }, [interactionCancelToken, onInteractionChange]);

  useEffect(
    () => () => {
      onEditorRegistration(windowState.id, null);
      if (drag.current || resize.current) onInteractionChange(false);
    },
    [onEditorRegistration, onInteractionChange, windowState.id],
  );

  const beginGeometry = (event: ReactPointerEvent<HTMLElement>, kind: 'move' | 'resize'): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate(windowState.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    const session: GeometrySession = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      original: windowState,
      current: windowState,
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
    };
    if (kind === 'move') drag.current = session;
    else resize.current = session;
    onInteractionChange(true);
  };

  const moveWindow = (event: ReactPointerEvent<HTMLElement>): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.intent = updatePointerDrag(session.intent, { x: event.clientX, y: event.clientY });
    if (session.intent.phase !== 'dragging') return;
    const surface = event.currentTarget.closest<HTMLElement>('.desktop-surface');
    const width = surface?.clientWidth ?? window.innerWidth;
    const height = surface?.clientHeight ?? window.innerHeight - 22;
    session.current = {
      ...session.original,
      x: Math.max(
        0,
        Math.min(
          width - 96,
          Math.round(session.original.x + event.clientX - session.intent.origin.x),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          height - 28,
          Math.round(session.original.y + event.clientY - session.intent.origin.y),
        ),
      ),
    };
    const element = event.currentTarget.closest<HTMLElement>('[data-write-window]');
    if (element) {
      element.style.transform = `translate(${session.current.x - session.original.x}px, ${session.current.y - session.original.y}px)`;
    }
  };

  const finishWindowMove = (event: ReactPointerEvent<HTMLElement>, commit: boolean): void => {
    const element = event.currentTarget.closest<HTMLElement>('[data-write-window]');
    if (element) element.style.transform = '';
    finishMove(event.pointerId, commit);
  };

  const resizeWindow = (event: ReactPointerEvent<HTMLElement>): void => {
    const session = resize.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.intent = updatePointerDrag(session.intent, { x: event.clientX, y: event.clientY });
    if (session.intent.phase !== 'dragging') return;
    const surface = event.currentTarget.closest<HTMLElement>('.desktop-surface');
    const maximumWidth = surface?.clientWidth ?? window.innerWidth;
    const maximumHeight = surface?.clientHeight ?? window.innerHeight - 22;
    session.current = {
      ...session.original,
      width: Math.max(
        520,
        Math.min(
          maximumWidth - session.original.x,
          Math.round(session.original.width + event.clientX - session.intent.origin.x),
        ),
      ),
      height: Math.max(
        360,
        Math.min(
          maximumHeight - session.original.y,
          Math.round(session.original.height + event.clientY - session.intent.origin.y),
        ),
      ),
    };
    onGeometry(windowState.id, session.current);
  };

  const finishResize = (event: ReactPointerEvent<HTMLElement>, commit: boolean): void => {
    const session = resize.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resize.current = null;
    if (session.target.hasPointerCapture(event.pointerId)) {
      session.target.releasePointerCapture(event.pointerId);
    }
    if (!commit) onGeometry(windowState.id, session.original);
    onInteractionChange(false);
  };

  return (
    <section
      aria-label={`${windowState.title} — Write window`}
      className={`finder-window write-window ${active ? 'is-active' : 'is-inactive'}`}
      data-document-format={windowState.draft.format}
      data-document-id={windowState.documentId ?? ''}
      data-write-title={windowState.title}
      data-write-window={windowState.id}
      onPointerDown={() => onActivate(windowState.id)}
      style={
        {
          left: windowState.x,
          top: windowState.y,
          width: windowState.width,
          height: windowState.height,
          zIndex: active ? 4_500 + stackIndex : 260 + Math.min(stackIndex, 30),
        } as CSSProperties
      }
    >
      <header
        className="window-titlebar write-titlebar"
        onLostPointerCapture={(event) => finishWindowMove(event, false)}
        onPointerCancel={(event) => finishWindowMove(event, false)}
        onPointerDown={(event) => beginGeometry(event, 'move')}
        onPointerMove={moveWindow}
        onPointerUp={(event) => finishWindowMove(event, true)}
      >
        <button
          aria-label={`Close ${windowState.title}`}
          className="window-close"
          onClick={(event) => {
            event.stopPropagation();
            onClose(windowState.id);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        />
        <h2>
          {windowState.title}
          {windowState.dirty ? ' •' : ''} — Write
        </h2>
        <button
          aria-label={`Zoom ${windowState.title}`}
          className="window-zoom"
          onClick={(event) => {
            event.stopPropagation();
            onZoom(windowState.id);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        />
      </header>
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
          active={active}
          editorRef={editorRegistration}
          onChange={(payload) => onDraftChange(windowState.id, payload)}
          onContextChange={(next) => onEditorContext(windowState.id, next)}
          onPaginationChange={(pageNumber, pageCount) =>
            onPaginationChange(windowState.id, pageNumber, pageCount)
          }
          payload={windowState.draft}
          zoom={windowState.zoom}
        />
      </div>
      <footer className="write-status-bar">
        <span>
          Page {windowState.pageNumber} of {windowState.pageCount}
        </span>
        <span>{windowState.zoom}%</span>
      </footer>
      <button
        aria-label={`Resize ${windowState.title}`}
        className="window-grow-box write-grow-box"
        onLostPointerCapture={(event) => finishResize(event, false)}
        onPointerCancel={(event) => finishResize(event, false)}
        onPointerDown={(event) => beginGeometry(event, 'resize')}
        onPointerMove={resizeWindow}
        onPointerUp={(event) => finishResize(event, true)}
        type="button"
      />
    </section>
  );
}
