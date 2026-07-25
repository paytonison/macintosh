import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { Point } from '../../shared/state';
import { PixelIcon, type PixelIconName } from './PixelIcon';

interface DesktopIconProps {
  id: 'system-disk' | 'trash';
  interactionCancelToken: number;
  label: string;
  icon: PixelIconName;
  position: Point;
  selected: boolean;
  dragging?: boolean;
  snapping?: boolean;
  ejecting?: boolean;
  validDropTarget?: boolean;
  onSelect: (id: 'system-disk' | 'trash', additive: boolean) => void;
  onOpen: (id: 'system-disk' | 'trash') => void;
  onDragStart: (id: 'system-disk' | 'trash', origin: Point) => void;
  onDrag: (id: 'system-disk' | 'trash', position: Point, pointer: Point) => void;
  onDragEnd: (id: 'system-disk' | 'trash', pointer: Point) => void;
  onDragCancel: (id: 'system-disk' | 'trash') => void;
  onInteractionChange: (active: boolean) => void;
}

interface DragSession {
  pointerId: number;
  captureTarget: HTMLButtonElement;
  origin: Point;
  pointerOrigin: Point;
  hasMoved: boolean;
}

export function DesktopIcon({
  id,
  interactionCancelToken,
  label,
  icon,
  position,
  selected,
  dragging = false,
  snapping = false,
  ejecting = false,
  validDropTarget = false,
  onSelect,
  onOpen,
  onDragStart,
  onDrag,
  onDragEnd,
  onDragCancel,
  onInteractionChange,
}: DesktopIconProps) {
  const session = useRef<DragSession | null>(null);
  const cancellationHandlers = useRef({ onDragCancel, onInteractionChange });

  useLayoutEffect(() => {
    cancellationHandlers.current = { onDragCancel, onInteractionChange };
  }, [onDragCancel, onInteractionChange]);

  useLayoutEffect(() => {
    const active = session.current;
    if (!active) return;
    if (active.captureTarget.hasPointerCapture(active.pointerId)) {
      active.captureTarget.releasePointerCapture(active.pointerId);
    }
    session.current = null;
    cancellationHandlers.current.onInteractionChange(false);
    if (active.hasMoved) cancellationHandlers.current.onDragCancel(id);
  }, [id, interactionCancelToken]);

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || ejecting) return;
    event.stopPropagation();
    onInteractionChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    session.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      origin: position,
      pointerOrigin: { x: event.clientX, y: event.clientY },
      hasMoved: false,
    };
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - active.pointerOrigin.x;
    const deltaY = event.clientY - active.pointerOrigin.y;
    if (!active.hasMoved && Math.hypot(deltaX, deltaY) >= 4) {
      active.hasMoved = true;
      onDragStart(id, active.origin);
    }
    if (!active.hasMoved) return;
    onDrag(
      id,
      { x: Math.round(active.origin.x + deltaX), y: Math.round(active.origin.y + deltaY) },
      { x: event.clientX, y: event.clientY },
    );
  };

  const pointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    session.current = null;
    onInteractionChange(false);
    if (active.hasMoved) {
      onDragEnd(id, { x: event.clientX, y: event.clientY });
    } else {
      onSelect(id, event.shiftKey);
    }
  };

  const pointerCancel = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    session.current = null;
    onInteractionChange(false);
    if (active.hasMoved) onDragCancel(id);
  };

  const style = {
    '--icon-x': `${Math.round(position.x)}px`,
    '--icon-y': `${Math.round(position.y)}px`,
  } as CSSProperties;

  return (
    <button
      aria-label={label}
      className={[
        'desktop-icon',
        selected ? 'is-selected' : '',
        dragging ? 'is-dragging' : '',
        snapping ? 'is-snapping' : '',
        ejecting ? 'is-ejecting' : '',
        validDropTarget ? 'is-drop-target' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-desktop-icon={id}
      data-drop-destination={id}
      data-drop-mode={id === 'trash' ? 'internal' : undefined}
      onDoubleClick={() => onOpen(id)}
      onPointerCancel={pointerCancel}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      style={style}
      type="button"
    >
      <span className="desktop-icon-glyph">
        <PixelIcon name={icon} size={id === 'trash' ? 40 : 32} />
      </span>
      <span className="desktop-icon-label">{label}</span>
    </button>
  );
}
