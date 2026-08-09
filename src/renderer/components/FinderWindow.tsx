import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
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
import { documentPayloadText } from '../../shared/write';
import { finderIconCanvasSize, resolveFinderIconPositions } from '../model/finder-icon-layout';
import { createIconDragPreviewItems } from '../model/icon-drag-preview';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from '../model/pointer-drag';
import type { VfsItemDragContext } from '../model/vfs-drag';
import {
  ClassicWindowAnimationShadow,
  ClassicWindowFrame,
  type ClassicWindowAnimation,
} from './ClassicWindowFrame';
import { ClassicScrollBars } from './ClassicScrollBars';
import { VfsNodeIcon } from './VfsNodeIcon';

export type FinderWindowAnimation = ClassicWindowAnimation;

interface FinderWindowProps {
  windowState: FinderWindowState;
  interactionCancelToken: number;
  node: VfsNode;
  items: VfsNode[];
  active: boolean;
  viewMode: FinderViewMode;
  selectedIds: Set<string>;
  stackIndex: number;
  animation?: FinderWindowAnimation;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onGeometry: (id: string, geometry: WindowGeometry) => void;
  onZoom: (id: string) => void;
  onItemSelect: (id: string, additive: boolean) => void;
  onItemOpen: (id: string, source: HTMLElement) => void;
  onItemDragStart: (id: string, context: VfsItemDragContext) => void;
  onItemDragMove: (pointer: Point) => void;
  onItemDragEnd: (pointer: Point) => void;
  onItemDragCancel: () => void;
  onInteractionChange: (active: boolean) => void;
}

interface FinderWindowAnimationShadowProps {
  animation: FinderWindowAnimation;
  onAnimationComplete: (id: string, phase: FinderWindowAnimation['phase'], token: number) => void;
  stackIndex: number;
  windowState: FinderWindowState;
}

export { committedWindowGeometry as committedResizeGeometry } from '../model/classic-window';

interface ItemDragSession {
  pointerId: number;
  captureTarget: HTMLButtonElement;
  itemId: string;
  context: VfsItemDragContext;
  intent: PointerDragIntent;
}

export function FinderWindowAnimationShadow({
  animation,
  onAnimationComplete,
  stackIndex,
  windowState,
}: FinderWindowAnimationShadowProps) {
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

export function FinderWindow({
  windowState,
  interactionCancelToken,
  node,
  items,
  active,
  viewMode,
  selectedIds,
  stackIndex,
  animation,
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
  const itemDrag = useRef<ItemDragSession | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const pressedItem = useRef<HTMLButtonElement | null>(null);
  const suppressedItemClick = useRef<string | null>(null);
  const suppressedItemClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancellationHandlers = useRef({ onItemDragCancel, onInteractionChange });

  const clearPressedItem = useCallback((): void => {
    pressedItem.current?.classList.remove('is-pointer-pressed');
    pressedItem.current = null;
  }, []);

  const cancelActiveItemDrag = useCallback(
    (notify: boolean): boolean => {
      const active = itemDrag.current;
      if (!active) return false;
      itemDrag.current = null;
      clearPressedItem();
      if (active.captureTarget.hasPointerCapture(active.pointerId)) {
        active.captureTarget.releasePointerCapture(active.pointerId);
      }
      if (notify) {
        if (releasePointerDrag(active.intent) === 'drag') {
          cancellationHandlers.current.onItemDragCancel();
        } else {
          cancellationHandlers.current.onInteractionChange(false);
        }
      }
      return true;
    },
    [clearPressedItem],
  );

  useLayoutEffect(() => {
    cancellationHandlers.current = { onItemDragCancel, onInteractionChange };
  }, [onItemDragCancel, onInteractionChange]);

  useLayoutEffect(() => {
    cancelActiveItemDrag(false);
  }, [cancelActiveItemDrag, interactionCancelToken]);

  useLayoutEffect(() => {
    const active = itemDrag.current;
    if (!active || items.some((item) => item.id === active.itemId)) return;
    cancelActiveItemDrag(true);
  }, [cancelActiveItemDrag, items]);

  useEffect(
    () => () => {
      if (suppressedItemClickTimer.current) clearTimeout(suppressedItemClickTimer.current);
      cancelActiveItemDrag(true);
    },
    [cancelActiveItemDrag],
  );
  const isDocument = node.kind === 'document';
  const resolvedIconPositions = resolveFinderIconPositions(items);
  const iconItems = items.map((item) => ({
    item,
    position: resolvedIconPositions.get(item.id) ?? { x: 0, y: 0 },
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
    const renderedItems = [
      ...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-vfs-item]') ??
        []),
    ];
    const previewItems = createIconDragPreviewItems(
      draggedItems.flatMap(({ item: candidate }) => {
        const renderedItem = renderedItems.find(
          (element) => element.dataset.vfsItem === candidate.id,
        );
        const icon = renderedItem?.querySelector('.pixel-icon');
        if (!icon) return [];
        const iconBounds = icon.getBoundingClientRect();
        return [
          {
            nodeId: candidate.id,
            bounds: {
              left: iconBounds.left,
              top: iconBounds.top,
              width: iconBounds.width,
              height: iconBounds.height,
            },
          },
        ];
      }),
      { x: event.clientX, y: event.clientY },
    );
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
      previewItems,
      source: 'finder',
    } satisfies VfsItemDragContext;
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
    <ClassicWindowFrame
      active={active}
      animation={animation}
      ariaLabel={`${node.name} window`}
      controlLabel={node.name}
      dataAttributes={{
        'data-drop-blocked': 'true',
        'data-finder-window': windowState.id,
      }}
      geometry={windowState}
      interactionCancelToken={interactionCancelToken}
      minimumHeight={220}
      minimumWidth={300}
      onActivate={onActivate}
      onClose={onClose}
      onGeometry={onGeometry}
      onInteractionChange={onInteractionChange}
      onZoom={onZoom}
      title={node.name}
      windowId={windowState.id}
      zIndex={300 + stackIndex}
    >
      {({ growBox }) => (
        <>
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
                <article className="document-sheet">
                  {node.payload ? documentPayloadText(node.payload) : ''}
                </article>
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
                      onDoubleClick={(event) => onItemOpen(item.id, event.currentTarget)}
                      onLostPointerCapture={loseItemPointerCapture}
                      onPointerCancel={(event) => finishItemPointer(event, false)}
                      onPointerDown={(event) => beginItemPress(event, item, position)}
                      onPointerMove={moveItem}
                      onPointerUp={(event) => finishItemPointer(event, true)}
                      style={{ left: position.x, top: position.y }}
                      type="button"
                    >
                      <span className="finder-item-glyph" data-icon-hit-region="artwork">
                        <VfsNodeIcon node={item} size={32} />
                      </span>
                      <span className="finder-item-label" data-icon-hit-region="label">
                        {item.name}
                      </span>
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
                      onDoubleClick={(event) => onItemOpen(item.id, event.currentTarget)}
                      onLostPointerCapture={loseItemPointerCapture}
                      onPointerCancel={(event) => finishItemPointer(event, false)}
                      onPointerDown={(event) => beginItemPress(event, item)}
                      onPointerMove={moveItem}
                      onPointerUp={(event) => finishItemPointer(event, true)}
                      role="listitem"
                      type="button"
                    >
                      <VfsNodeIcon node={item} size={16} />
                      <span>{item.name}</span>
                      <span className="finder-kind">{item.kind}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ClassicScrollBars viewportRef={content} />
            {growBox}
          </div>
        </>
      )}
    </ClassicWindowFrame>
  );
}
