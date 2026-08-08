import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { WRITE_PAGE_MARGIN, WRITE_PAGE_WIDTH, type DocumentPayload } from '../../shared/write';
import type { WindowGeometry } from '../../shared/state';
import {
  ClassicWindowAnimationShadow,
  ClassicWindowFrame,
  type ClassicWindowAnimation,
} from './ClassicWindowFrame';
import { ClassicScrollBars } from './ClassicScrollBars';
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
  onAnimationComplete: (id: string, phase: WriteWindowAnimation['phase'], token: number) => void;
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
  onAnimationComplete,
  stackIndex,
  windowState,
}: WriteWindowAnimationShadowProps) {
  return (
    <ClassicWindowAnimationShadow
      animation={animation}
      geometry={windowState}
      onAnimationComplete={onAnimationComplete}
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
  const scale = windowState.zoom / 100;
  const editorHandle = useRef<WriteEditorHandle | null>(null);
  const documentViewport = useRef<HTMLDivElement>(null);
  const rulerViewport = useRef<HTMLDivElement>(null);
  const syncRulerScroll = useCallback((): void => {
    if (!documentViewport.current || !rulerViewport.current) return;
    const page = documentViewport.current.querySelector<HTMLElement>('.write-page-stack');
    const rulerPage = rulerViewport.current.querySelector<HTMLElement>('.write-ruler-page');
    if (page && rulerPage) {
      const pageOffset = Math.round(
        page.getBoundingClientRect().left -
          documentViewport.current.getBoundingClientRect().left +
          documentViewport.current.scrollLeft,
      );
      rulerPage.style.marginLeft = `${String(pageOffset)}px`;
    }
    rulerViewport.current.scrollLeft = documentViewport.current.scrollLeft;
  }, []);
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

  useLayoutEffect(() => {
    syncRulerScroll();
  }, [syncRulerScroll, windowState.height, windowState.width, windowState.zoom]);

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
      interactionCancelToken={interactionCancelToken}
      minimumHeight={360}
      minimumWidth={520}
      onActivate={onActivate}
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
            <div className="write-ruler-scroll-viewport" ref={rulerViewport}>
              <div
                className="write-ruler-page"
                style={{
                  paddingLeft: WRITE_PAGE_MARGIN * scale,
                  width: WRITE_PAGE_WIDTH * scale,
                }}
              >
                <WriteRuler
                  disabled={!context.canFormat}
                  interactionCancelToken={interactionCancelToken}
                  onCommand={(command: WriteEditorCommand) =>
                    editorHandle.current?.execute(command)
                  }
                  onInteractionChange={onInteractionChange}
                  style={context.style}
                  zoom={windowState.zoom}
                />
              </div>
            </div>
            <div aria-hidden="true" className="write-ruler-scroll-gutter" />
          </div>
          <div className="window-scroll-frame write-scroll-frame">
            <div
              className="write-document-viewport"
              onScroll={syncRulerScroll}
              onPointerDown={() => onActivate(windowState.id)}
              ref={documentViewport}
            >
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
            <ClassicScrollBars viewportRef={documentViewport} />
            {growBox}
          </div>
          <footer className="write-status-bar">
            <span role={layoutError ? 'alert' : undefined}>
              {layoutError ?? `Page ${windowState.pageNumber} of ${windowState.pageCount}`}
            </span>
            <span>{windowState.zoom}%</span>
          </footer>
        </>
      )}
    </ClassicWindowFrame>
  );
}
