import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type {
  FinderViewMode,
  FinderWindowState,
  VfsNode,
  WindowGeometry,
} from '../../shared/state';
import { PixelIcon, type PixelIconName } from './PixelIcon';

interface FinderWindowProps {
  windowState: FinderWindowState;
  interactionCancelToken: number;
  node: VfsNode;
  items: VfsNode[];
  active: boolean;
  viewMode: FinderViewMode;
  selectedIds: Set<string>;
  stackIndex: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onGeometry: (id: string, geometry: WindowGeometry) => void;
  onZoom: (id: string) => void;
  onItemSelect: (id: string, additive: boolean) => void;
  onItemOpen: (id: string) => void;
  onItemDragStart: (id: string, dataTransfer: DataTransfer) => void;
  onItemDragEnd: () => void;
  onInteractionChange: (active: boolean) => void;
}

interface GeometrySession {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  captureTarget: HTMLElement;
  original: WindowGeometry;
  current: WindowGeometry;
  hasMoved: boolean;
}

const iconForNode = (node: VfsNode): PixelIconName => {
  if (node.id === 'system-folder') return 'system-folder';
  if (node.kind === 'folder' || node.kind === 'disk' || node.kind === 'trash') return 'folder';
  return 'document';
};

export function FinderWindow({
  windowState,
  interactionCancelToken,
  node,
  items,
  active,
  viewMode,
  selectedIds,
  stackIndex,
  onActivate,
  onClose,
  onGeometry,
  onZoom,
  onItemSelect,
  onItemOpen,
  onItemDragStart,
  onItemDragEnd,
  onInteractionChange,
}: FinderWindowProps) {
  const drag = useRef<GeometrySession | null>(null);
  const resize = useRef<GeometrySession | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const windowElement = useRef<HTMLElement>(null);
  const dragShadow = useRef<HTMLDivElement>(null);
  const dragReleaseCleanup = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const moveSession = drag.current;
    const resizeSession = resize.current;
    if (!moveSession && !resizeSession) return;
    dragReleaseCleanup.current?.();
    dragReleaseCleanup.current = null;
    for (const session of [moveSession, resizeSession]) {
      if (session?.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
    }
    drag.current = null;
    resize.current = null;
    windowElement.current?.classList.remove('is-shadow-dragging');
    if (windowElement.current) delete windowElement.current.dataset.windowDragging;
    if (dragShadow.current) dragShadow.current.style.transform = 'translate3d(0, 0, 0)';
    onInteractionChange(false);
  }, [interactionCancelToken, onInteractionChange]);

  const clearDragShadow = (): void => {
    windowElement.current?.classList.remove('is-shadow-dragging');
    if (windowElement.current) delete windowElement.current.dataset.windowDragging;
    if (dragShadow.current) dragShadow.current.style.transform = 'translate3d(0, 0, 0)';
  };

  const removeDragReleaseListeners = (): void => {
    dragReleaseCleanup.current?.();
    dragReleaseCleanup.current = null;
  };

  const finishWindowMove = (pointerId: number, commit: boolean): void => {
    const session = drag.current;
    if (!session || session.pointerId !== pointerId) return;
    removeDragReleaseListeners();
    if (session.captureTarget.hasPointerCapture(pointerId)) {
      session.captureTarget.releasePointerCapture(pointerId);
    }
    drag.current = null;
    clearDragShadow();
    onInteractionChange(false);
    if (commit && session.hasMoved) onGeometry(windowState.id, session.current);
  };

  const watchWindowMoveRelease = (pointerId: number): void => {
    removeDragReleaseListeners();
    const pointerUp = (event: PointerEvent): void => {
      if (event.pointerId === pointerId) finishWindowMove(pointerId, true);
    };
    const pointerCancel = (event: PointerEvent): void => {
      if (event.pointerId === pointerId) finishWindowMove(pointerId, false);
    };
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerCancel, true);
    dragReleaseCleanup.current = () => {
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointercancel', pointerCancel, true);
    };
  };

  useEffect(
    () => () => {
      dragReleaseCleanup.current?.();
      dragReleaseCleanup.current = null;
      if (drag.current || resize.current) onInteractionChange(false);
    },
    [onInteractionChange],
  );

  const beginGeometry = (
    event: ReactPointerEvent<HTMLElement>,
    target: 'drag' | 'resize',
  ): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onActivate(windowState.id);
    onInteractionChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const session = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      captureTarget: event.currentTarget,
      original: windowState,
      current: windowState,
      hasMoved: false,
    };
    if (target === 'drag') {
      drag.current = session;
      watchWindowMoveRelease(session.pointerId);
    } else {
      resize.current = session;
    }
  };

  const moveWindow = (event: ReactPointerEvent<HTMLElement>): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const surface = windowElement.current?.closest<HTMLElement>('.desktop-surface');
    const maximumWidth = surface?.clientWidth ?? window.innerWidth;
    const maximumHeight = surface?.clientHeight ?? window.innerHeight - 22;
    const next = {
      ...session.original,
      x: Math.max(
        0,
        Math.min(
          maximumWidth - 96,
          Math.round(session.original.x + event.clientX - session.pointerX),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          maximumHeight - 28,
          Math.round(session.original.y + event.clientY - session.pointerY),
        ),
      ),
    };
    session.current = next;
    session.hasMoved = next.x !== session.original.x || next.y !== session.original.y;
    if (session.hasMoved && windowElement.current) {
      windowElement.current.classList.add('is-shadow-dragging');
      windowElement.current.dataset.windowDragging = 'true';
    }
    if (dragShadow.current) {
      dragShadow.current.style.transform = `translate3d(${next.x - session.original.x}px, ${next.y - session.original.y}px, 0)`;
    }
  };

  const resizeWindow = (event: ReactPointerEvent<HTMLElement>): void => {
    const session = resize.current;
    if (!session || session.pointerId !== event.pointerId) return;
    onGeometry(windowState.id, {
      ...session.original,
      width: Math.max(300, Math.round(session.original.width + event.clientX - session.pointerX)),
      height: Math.max(220, Math.round(session.original.height + event.clientY - session.pointerY)),
    });
  };

  const releasePointer = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const commitWindowMove = (event: ReactPointerEvent<HTMLElement>): void => {
    finishWindowMove(event.pointerId, true);
  };

  const cancelWindowMove = (event: ReactPointerEvent<HTMLElement>): void => {
    finishWindowMove(event.pointerId, false);
  };

  const endResize = (event: ReactPointerEvent<HTMLElement>): void => {
    releasePointer(event);
    resize.current = null;
    onInteractionChange(false);
  };

  const style = {
    left: windowState.x,
    top: windowState.y,
    width: windowState.width,
    height: windowState.height,
    zIndex: 300 + stackIndex,
  } as CSSProperties;

  const isDocument = node.kind === 'document';

  return (
    <section
      aria-label={`${node.name} window`}
      className={`finder-window ${active ? 'is-active' : 'is-inactive'}`}
      data-drop-blocked="true"
      data-finder-window={windowState.id}
      onPointerDown={() => onActivate(windowState.id)}
      ref={windowElement}
      style={style}
    >
      <div aria-hidden="true" className="window-drag-shadow" ref={dragShadow}>
        <span />
      </div>
      <div
        className="window-titlebar"
        data-window-drag-handle="true"
        onDoubleClick={() => onZoom(windowState.id)}
        onPointerCancel={cancelWindowMove}
        onPointerDown={(event) => beginGeometry(event, 'drag')}
        onPointerMove={moveWindow}
        onPointerUp={commitWindowMove}
      >
        <button
          aria-label={`Close ${node.name}`}
          className="window-close"
          onClick={(event) => {
            event.stopPropagation();
            onClose(windowState.id);
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            onActivate(windowState.id);
          }}
          type="button"
        />
        <h2>{node.name}</h2>
        <button
          aria-label={`Zoom ${node.name}`}
          className="window-zoom"
          onClick={(event) => {
            event.stopPropagation();
            onZoom(windowState.id);
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            onActivate(windowState.id);
          }}
          type="button"
        />
      </div>
      <div className="window-info-bar">
        <span>
          {isDocument ? '1 page' : `${items.length} item${items.length === 1 ? '' : 's'}`}
        </span>
        <span>{node.kind === 'disk' ? '232K in disk' : 'System Disk'}</span>
        <span>{node.kind === 'disk' ? '168K available' : ''}</span>
      </div>
      <div className="window-scroll-frame">
        <div
          className="window-content"
          data-drop-blocked={isDocument ? 'true' : undefined}
          data-drop-destination={isDocument ? undefined : node.id}
          ref={content}
        >
          {isDocument ? (
            <article className="document-sheet">{node.content ?? ''}</article>
          ) : viewMode === 'icons' ? (
            <div className="finder-icon-grid">
              {items.map((item) => (
                <button
                  className={`finder-item ${selectedIds.has(item.id) ? 'is-selected' : ''}`}
                  data-drop-destination={item.kind === 'folder' ? item.id : undefined}
                  data-vfs-item={item.id}
                  draggable
                  key={item.id}
                  onClick={(event) => onItemSelect(item.id, event.shiftKey)}
                  onDoubleClick={() => onItemOpen(item.id)}
                  onDragStart={(event: ReactDragEvent<HTMLButtonElement>) =>
                    onItemDragStart(item.id, event.dataTransfer)
                  }
                  onDragEnd={onItemDragEnd}
                  type="button"
                >
                  <PixelIcon name={iconForNode(item)} size={32} />
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="finder-list" role="list">
              {items.map((item) => (
                <button
                  className={`finder-list-row ${selectedIds.has(item.id) ? 'is-selected' : ''}`}
                  data-drop-destination={item.kind === 'folder' ? item.id : undefined}
                  data-vfs-item={item.id}
                  draggable
                  key={item.id}
                  onClick={(event) => onItemSelect(item.id, event.shiftKey)}
                  onDoubleClick={() => onItemOpen(item.id)}
                  onDragStart={(event: ReactDragEvent<HTMLButtonElement>) =>
                    onItemDragStart(item.id, event.dataTransfer)
                  }
                  onDragEnd={onItemDragEnd}
                  role="listitem"
                  type="button"
                >
                  <PixelIcon name={iconForNode(item)} size={16} />
                  <span>{item.name}</span>
                  <span className="finder-kind">{item.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="scrollbar scrollbar-vertical" aria-hidden="true">
          <button
            onClick={() => content.current?.scrollBy({ top: -64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow up" />
          </button>
          <div className="scroll-track vertical-track">
            <div className="scroll-thumb vertical-thumb" />
          </div>
          <button
            onClick={() => content.current?.scrollBy({ top: 64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow down" />
          </button>
        </div>
        <div className="scrollbar scrollbar-horizontal" aria-hidden="true">
          <button
            onClick={() => content.current?.scrollBy({ left: -64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow left" />
          </button>
          <div className="scroll-track horizontal-track">
            <div className="scroll-thumb horizontal-thumb" />
          </div>
          <button
            onClick={() => content.current?.scrollBy({ left: 64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow right" />
          </button>
        </div>
        <button
          aria-label={`Resize ${node.name}`}
          className="window-grow-box"
          onPointerCancel={endResize}
          onPointerDown={(event) => beginGeometry(event, 'resize')}
          onPointerMove={resizeWindow}
          onPointerUp={endResize}
          type="button"
        >
          <span />
        </button>
      </div>
    </section>
  );
}
