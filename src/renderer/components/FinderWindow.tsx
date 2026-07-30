import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type {
  FinderViewMode,
  FinderWindowState,
  Point,
  VfsNode,
  WindowGeometry,
} from '../../shared/state';
import {
  finderIconCanvasSize,
  resolveFinderIconPosition,
  type FinderIconDragLayout,
} from '../model/finder-icon-layout';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from '../model/pointer-drag';
import { PixelIcon, type PixelIconName } from './PixelIcon';

export interface FinderItemDragContext {
  parentId: string;
  nodeIds: string[];
  layout: FinderIconDragLayout | null;
}

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
  onItemDragStart: (id: string, context: FinderItemDragContext) => void;
  onItemDragMove: (pointer: Point) => void;
  onItemDragEnd: (pointer: Point) => void;
  onItemDragCancel: () => void;
  onInteractionChange: (active: boolean) => void;
}

interface GeometrySession {
  pointerId: number;
  captureTarget: HTMLElement;
  original: WindowGeometry;
  current: WindowGeometry;
  intent: PointerDragIntent;
}

interface ItemDragSession {
  pointerId: number;
  captureTarget: HTMLButtonElement;
  itemId: string;
  context: FinderItemDragContext;
  intent: PointerDragIntent;
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
  onItemDragMove,
  onItemDragEnd,
  onItemDragCancel,
  onInteractionChange,
}: FinderWindowProps) {
  const drag = useRef<GeometrySession | null>(null);
  const resize = useRef<GeometrySession | null>(null);
  const itemDrag = useRef<ItemDragSession | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const windowElement = useRef<HTMLElement>(null);
  const dragShadow = useRef<HTMLDivElement>(null);
  const dragReleaseCleanup = useRef<(() => void) | null>(null);
  const pressedItem = useRef<HTMLButtonElement | null>(null);
  const suppressedItemClick = useRef<string | null>(null);
  const suppressedItemClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancellationHandlers = useRef({ onGeometry, onItemDragCancel, onInteractionChange });

  const clearPressedItem = useCallback((): void => {
    pressedItem.current?.classList.remove('is-pointer-pressed');
    pressedItem.current = null;
  }, []);

  useLayoutEffect(() => {
    cancellationHandlers.current = { onGeometry, onItemDragCancel, onInteractionChange };
  }, [onGeometry, onItemDragCancel, onInteractionChange]);

  useLayoutEffect(() => {
    const active = itemDrag.current;
    itemDrag.current = null;
    clearPressedItem();
    if (active?.captureTarget.hasPointerCapture(active.pointerId)) {
      active.captureTarget.releasePointerCapture(active.pointerId);
    }
  }, [clearPressedItem, interactionCancelToken]);

  useLayoutEffect(() => {
    const moveSession = drag.current;
    const resizeSession = resize.current;
    if (!moveSession && !resizeSession) return;
    dragReleaseCleanup.current?.();
    dragReleaseCleanup.current = null;
    drag.current = null;
    resize.current = null;
    for (const session of [moveSession, resizeSession]) {
      if (session?.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
    }
    windowElement.current?.classList.remove('is-shadow-dragging');
    if (windowElement.current) delete windowElement.current.dataset.windowDragging;
    if (dragShadow.current) dragShadow.current.style.transform = 'translate3d(0, 0, 0)';
    if (resizeSession?.intent.phase === 'dragging') {
      cancellationHandlers.current.onGeometry(windowState.id, resizeSession.original);
    }
    cancellationHandlers.current.onInteractionChange(false);
  }, [interactionCancelToken, windowState.id]);

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
    drag.current = null;
    if (session.captureTarget.hasPointerCapture(pointerId)) {
      session.captureTarget.releasePointerCapture(pointerId);
    }
    clearDragShadow();
    onInteractionChange(false);
    if (
      commit &&
      releasePointerDrag(session.intent) === 'drag' &&
      (session.current.x !== session.original.x || session.current.y !== session.original.y)
    ) {
      onGeometry(windowState.id, session.current);
    }
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
      if (suppressedItemClickTimer.current) clearTimeout(suppressedItemClickTimer.current);
      const activeItem = itemDrag.current;
      itemDrag.current = null;
      clearPressedItem();
      if (activeItem?.captureTarget.hasPointerCapture(activeItem.pointerId)) {
        activeItem.captureTarget.releasePointerCapture(activeItem.pointerId);
      }
      if (activeItem?.intent.phase === 'dragging') {
        cancellationHandlers.current.onItemDragCancel();
      } else if (activeItem || drag.current || resize.current) {
        cancellationHandlers.current.onInteractionChange(false);
      }
    },
    [clearPressedItem],
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
      captureTarget: event.currentTarget,
      original: windowState,
      current: windowState,
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
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
    session.intent = updatePointerDrag(session.intent, {
      x: event.clientX,
      y: event.clientY,
    });
    if (session.intent.phase !== 'dragging') return;
    const surface = windowElement.current?.closest<HTMLElement>('.desktop-surface');
    const maximumWidth = surface?.clientWidth ?? window.innerWidth;
    const maximumHeight = surface?.clientHeight ?? window.innerHeight - 22;
    const next = {
      ...session.original,
      x: Math.max(
        0,
        Math.min(
          maximumWidth - 96,
          Math.round(session.original.x + event.clientX - session.intent.origin.x),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          maximumHeight - 28,
          Math.round(session.original.y + event.clientY - session.intent.origin.y),
        ),
      ),
    };
    session.current = next;
    if (windowElement.current) {
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
    session.intent = updatePointerDrag(session.intent, {
      x: event.clientX,
      y: event.clientY,
    });
    if (session.intent.phase !== 'dragging') return;
    const next = {
      ...session.original,
      width: Math.max(
        300,
        Math.round(session.original.width + event.clientX - session.intent.origin.x),
      ),
      height: Math.max(
        220,
        Math.round(session.original.height + event.clientY - session.intent.origin.y),
      ),
    };
    session.current = next;
    onGeometry(windowState.id, next);
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

  const finishResize = (event: ReactPointerEvent<HTMLElement>, commit: boolean): void => {
    const session = resize.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resize.current = null;
    releasePointer(event);
    if (!commit && session.intent.phase === 'dragging') {
      onGeometry(windowState.id, session.original);
    }
    onInteractionChange(false);
  };

  const loseResizeCapture = (event: ReactPointerEvent<HTMLElement>): void => {
    const session = resize.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resize.current = null;
    if (session.intent.phase === 'dragging') {
      onGeometry(windowState.id, session.original);
    }
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
  const iconItems = items.map((item, index) => ({
    item,
    position: resolveFinderIconPosition(item, index),
  }));
  const iconCanvasSize = finderIconCanvasSize(iconItems.map(({ position }) => position));

  const beginItemPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: VfsNode,
    position?: Point,
  ): void => {
    if (event.button !== 0) return;
    clearPressedItem();
    const draggedItems = selectedIds.has(item.id)
      ? iconItems.filter(({ item: candidate }) => selectedIds.has(candidate.id))
      : iconItems.filter(({ item: candidate }) => candidate.id === item.id);
    const bounds = event.currentTarget.getBoundingClientRect();
    const context = {
      parentId: node.id,
      nodeIds: draggedItems.map(({ item: candidate }) => candidate.id),
      layout: position
        ? {
            anchorId: item.id,
            pointerOffset: {
              x: Math.round(event.clientX - bounds.left),
              y: Math.round(event.clientY - bounds.top),
            },
            positions: Object.fromEntries(
              draggedItems.map(({ item: candidate, position: candidatePosition }) => [
                candidate.id,
                candidatePosition,
              ]),
            ),
          }
        : null,
    } satisfies FinderItemDragContext;
    onInteractionChange(true);
    pressedItem.current = event.currentTarget;
    event.currentTarget.classList.add('is-pointer-pressed');
    event.currentTarget.setPointerCapture(event.pointerId);
    itemDrag.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      itemId: item.id,
      context,
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
    };
  };

  const moveItem = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = itemDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const previousPhase = active.intent.phase;
    active.intent = updatePointerDrag(active.intent, {
      x: event.clientX,
      y: event.clientY,
    });
    if (previousPhase === 'pressed' && active.intent.phase === 'dragging') {
      clearPressedItem();
      onItemDragStart(active.itemId, active.context);
    }
    if (active.intent.phase !== 'dragging') return;
    event.preventDefault();
    onItemDragMove({ x: event.clientX, y: event.clientY });
  };

  const suppressItemClick = (itemId: string): void => {
    suppressedItemClick.current = itemId;
    if (suppressedItemClickTimer.current) clearTimeout(suppressedItemClickTimer.current);
    suppressedItemClickTimer.current = setTimeout(() => {
      if (suppressedItemClick.current === itemId) suppressedItemClick.current = null;
      suppressedItemClickTimer.current = null;
    }, 0);
  };

  const finishItemPointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
    commit: boolean,
  ): void => {
    const active = itemDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    itemDrag.current = null;
    clearPressedItem();
    if (active.captureTarget.hasPointerCapture(active.pointerId)) {
      active.captureTarget.releasePointerCapture(active.pointerId);
    }
    if (releasePointerDrag(active.intent) === 'click') {
      onInteractionChange(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressItemClick(active.itemId);
    if (commit) onItemDragEnd({ x: event.clientX, y: event.clientY });
    else onItemDragCancel();
  };

  const loseItemPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = itemDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    itemDrag.current = null;
    clearPressedItem();
    if (releasePointerDrag(active.intent) === 'drag') onItemDragCancel();
    else onInteractionChange(false);
  };

  const selectItem = (event: ReactMouseEvent<HTMLButtonElement>, itemId: string): void => {
    if (suppressedItemClick.current === itemId) {
      suppressedItemClick.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onItemSelect(itemId, event.shiftKey);
  };

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
          data-drop-destination={isDocument || viewMode === 'icons' ? undefined : node.id}
          ref={content}
        >
          {isDocument ? (
            <article className="document-sheet">{node.content ?? ''}</article>
          ) : viewMode === 'icons' ? (
            <div
              className="finder-icon-grid"
              data-drop-destination={node.id}
              data-icon-layout-parent={node.id}
              style={{ minHeight: iconCanvasSize.height, minWidth: iconCanvasSize.width }}
            >
              {iconItems.map(({ item, position }) => (
                <button
                  className={`finder-item ${selectedIds.has(item.id) ? 'is-selected' : ''}`}
                  data-drop-destination={item.kind === 'folder' ? item.id : undefined}
                  data-icon-x={position.x}
                  data-icon-y={position.y}
                  data-vfs-item={item.id}
                  key={item.id}
                  onClick={(event) => selectItem(event, item.id)}
                  onDoubleClick={() => onItemOpen(item.id)}
                  onLostPointerCapture={loseItemPointerCapture}
                  onPointerCancel={(event) => finishItemPointer(event, false)}
                  onPointerDown={(event) => beginItemPress(event, item, position)}
                  onPointerMove={moveItem}
                  onPointerUp={(event) => finishItemPointer(event, true)}
                  style={{ left: position.x, top: position.y }}
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
                  key={item.id}
                  onClick={(event) => selectItem(event, item.id)}
                  onDoubleClick={() => onItemOpen(item.id)}
                  onLostPointerCapture={loseItemPointerCapture}
                  onPointerCancel={(event) => finishItemPointer(event, false)}
                  onPointerDown={(event) => beginItemPress(event, item)}
                  onPointerMove={moveItem}
                  onPointerUp={(event) => finishItemPointer(event, true)}
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
          onLostPointerCapture={loseResizeCapture}
          onPointerCancel={(event) => finishResize(event, false)}
          onPointerDown={(event) => beginGeometry(event, 'resize')}
          onPointerMove={resizeWindow}
          onPointerUp={(event) => finishResize(event, true)}
          type="button"
        />
      </div>
    </section>
  );
}
