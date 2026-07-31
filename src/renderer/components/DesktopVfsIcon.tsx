import {
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { Point, VfsNode } from '../../shared/state';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from '../model/pointer-drag';
import { VfsNodeIcon } from './VfsNodeIcon';

interface DesktopVfsIconProps {
  interactionCancelToken: number;
  node: VfsNode;
  position: Point;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string, source: HTMLElement) => void;
  onDragStart: (id: string, pointerOffset: Point, pointerOrigin: Point) => void;
  onDragMove: (pointer: Point) => void;
  onDragEnd: (pointer: Point) => void;
  onDragCancel: () => void;
  onInteractionChange: (active: boolean) => void;
}

interface DragSession {
  pointerId: number;
  captureTarget: HTMLButtonElement;
  pointerOffset: Point;
  intent: PointerDragIntent;
}

export function DesktopVfsIcon({
  interactionCancelToken,
  node,
  position,
  selected,
  onSelect,
  onOpen,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
  onInteractionChange,
}: DesktopVfsIconProps) {
  const session = useRef<DragSession | null>(null);
  const cancellationHandlers = useRef({ onDragCancel, onInteractionChange });

  useLayoutEffect(() => {
    cancellationHandlers.current = { onDragCancel, onInteractionChange };
  }, [onDragCancel, onInteractionChange]);

  const cancelActiveSession = useCallback((): void => {
    const active = session.current;
    if (!active) return;
    session.current = null;
    active.captureTarget.classList.remove('is-pointer-pressed');
    if (active.captureTarget.hasPointerCapture(active.pointerId)) {
      active.captureTarget.releasePointerCapture(active.pointerId);
    }
    if (releasePointerDrag(active.intent) === 'drag') {
      cancellationHandlers.current.onDragCancel();
    } else {
      cancellationHandlers.current.onInteractionChange(false);
    }
  }, []);

  useLayoutEffect(() => {
    cancelActiveSession();
  }, [cancelActiveSession, interactionCancelToken]);

  useLayoutEffect(() => () => cancelActiveSession(), [cancelActiveSession]);

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onInteractionChange(true);
    event.currentTarget.classList.add('is-pointer-pressed');
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    session.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      pointerOffset: {
        x: Math.round(event.clientX - bounds.left),
        y: Math.round(event.clientY - bounds.top),
      },
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
    };
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const previousPhase = active.intent.phase;
    active.intent = updatePointerDrag(active.intent, {
      x: event.clientX,
      y: event.clientY,
    });
    if (previousPhase === 'pressed' && active.intent.phase === 'dragging') {
      active.captureTarget.classList.remove('is-pointer-pressed');
      onDragStart(node.id, active.pointerOffset, active.intent.origin);
    }
    if (active.intent.phase !== 'dragging') return;
    event.preventDefault();
    onDragMove({ x: event.clientX, y: event.clientY });
  };

  const pointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    session.current = null;
    active.captureTarget.classList.remove('is-pointer-pressed');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (releasePointerDrag(active.intent) === 'drag') {
      event.preventDefault();
      event.stopPropagation();
      onDragEnd({ x: event.clientX, y: event.clientY });
    } else {
      onInteractionChange(false);
      onSelect(node.id, event.shiftKey);
    }
  };

  const cancelPointer = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    session.current = null;
    active.captureTarget.classList.remove('is-pointer-pressed');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (releasePointerDrag(active.intent) === 'drag') onDragCancel();
    else onInteractionChange(false);
  };

  const lostPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    session.current = null;
    active.captureTarget.classList.remove('is-pointer-pressed');
    if (releasePointerDrag(active.intent) === 'drag') onDragCancel();
    else onInteractionChange(false);
  };

  const style = {
    '--icon-x': `${Math.round(position.x)}px`,
    '--icon-y': `${Math.round(position.y)}px`,
  } as CSSProperties;

  return (
    <button
      aria-label={node.name}
      className={['desktop-icon', 'desktop-vfs-icon', selected ? 'is-selected' : '']
        .filter(Boolean)
        .join(' ')}
      data-desktop-icon={node.id}
      data-desktop-vfs-item={node.id}
      data-drop-blocked={node.kind === 'folder' ? undefined : 'true'}
      data-drop-destination={node.kind === 'folder' ? node.id : undefined}
      data-icon-x={position.x}
      data-icon-y={position.y}
      data-vfs-node-id={node.id}
      onClick={(event) => {
        // Pointer releases select inside the captured session above. A zero-detail
        // click is keyboard or programmatic activation and has no pointer release.
        if (event.detail === 0) onSelect(node.id, event.shiftKey);
      }}
      onDoubleClick={(event) => onOpen(node.id, event.currentTarget)}
      onLostPointerCapture={lostPointerCapture}
      onPointerCancel={cancelPointer}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      style={style}
      type="button"
    >
      <span className="desktop-icon-glyph">
        <VfsNodeIcon node={node} size={32} />
      </span>
      <span className="desktop-icon-label" data-desktop-icon-label={node.id}>
        {node.name}
      </span>
    </button>
  );
}
