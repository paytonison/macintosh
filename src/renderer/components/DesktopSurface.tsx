import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { Point } from '../../shared/state';
import type { Rectangle } from '../../shared/vfs';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from '../model/pointer-drag';
import { desktopIconIdsInRectangle } from '../model/desktop-icon-layout';
import { isTrashDropPoint } from '../model/desktop-drop-target';

export interface IconDropLocation {
  parentId: string;
  point: Point;
  surfaceSize: { width: number; height: number };
}

export interface DesktopDropTarget {
  destinationId: string;
  element: HTMLElement;
}

export const resolveDesktopDropTarget = (
  surface: HTMLElement | null,
  target: EventTarget | null,
  external: boolean,
  ignoredNodeIds: ReadonlySet<string> = new Set(),
  pointer?: Point,
): DesktopDropTarget | null => {
  let element =
    target instanceof HTMLElement
      ? target
      : target instanceof Element
        ? target.parentElement
        : null;
  while (element && surface?.contains(element)) {
    const nodeId = element.dataset.vfsNodeId;
    if (nodeId && ignoredNodeIds.has(nodeId)) {
      element = element.parentElement;
      continue;
    }
    const destinationId = element.dataset.dropDestination;
    if (destinationId) {
      if (ignoredNodeIds.has(destinationId)) {
        element = element.parentElement;
        continue;
      }
      if (external && (destinationId === 'trash' || element.dataset.dropMode === 'internal')) {
        return null;
      }
      if (destinationId === 'trash' && pointer && !isTrashDropPoint(pointer, element)) return null;
      return { destinationId, element };
    }
    if (element.dataset.dropBlocked === 'true') return null;
    element = element.parentElement;
  }
  return null;
};

interface DesktopSurfaceProps {
  children: ReactNode;
  interactionCancelToken: number;
  vfsCount: number;
  onBackgroundClick: () => void;
  onMarquee: (ids: string[]) => void;
  onDropItems: (
    destinationId: string,
    nodeIds: string[],
    files: File[],
    iconLocation: IconDropLocation | null,
  ) => void;
  onInteractionChange: (active: boolean) => void;
}

interface MarqueeState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  intent: PointerDragIntent;
}

export function DesktopSurface({
  children,
  interactionCancelToken,
  vfsCount,
  onBackgroundClick,
  onMarquee,
  onDropItems,
  onInteractionChange,
}: DesktopSurfaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  const highlightedDropTarget = useRef<HTMLElement | null>(null);
  const marqueeSession = useRef<MarqueeState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);

  useLayoutEffect(() => {
    const active = marqueeSession.current;
    if (active) {
      marqueeSession.current = null;
      if (surface.current?.hasPointerCapture(active.pointerId)) {
        surface.current.releasePointerCapture(active.pointerId);
      }
      setMarquee(null);
      onInteractionChange(false);
    }
    highlightedDropTarget.current?.classList.remove('is-file-drop-target');
    highlightedDropTarget.current = null;
  }, [interactionCancelToken, onInteractionChange]);

  const clearDropTarget = (): void => {
    highlightedDropTarget.current?.classList.remove('is-file-drop-target');
    highlightedDropTarget.current = null;
  };

  const dragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    onInteractionChange(true);
    const target = resolveDesktopDropTarget(surface.current, event.target, true, new Set(), {
      x: event.clientX,
      y: event.clientY,
    });
    if (!target) {
      clearDropTarget();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (highlightedDropTarget.current !== target.element) {
      clearDropTarget();
      highlightedDropTarget.current = target.element;
      target.element.classList.add('is-file-drop-target');
    }
  };

  const drop = (event: ReactDragEvent<HTMLDivElement>): void => {
    onInteractionChange(false);
    const files = Array.from(event.dataTransfer.files);
    const target = resolveDesktopDropTarget(surface.current, event.target, true, new Set(), {
      x: event.clientX,
      y: event.clientY,
    });
    clearDropTarget();
    if (!target || files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const layoutParent = target.element.dataset.iconLayoutParent;
    const bounds = layoutParent ? target.element.getBoundingClientRect() : null;
    onDropItems(
      target.destinationId,
      [],
      files,
      layoutParent && bounds
        ? {
            parentId: layoutParent,
            point: {
              x: Math.round(event.clientX - bounds.left),
              y: Math.round(event.clientY - bounds.top),
            },
            surfaceSize: {
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            },
          }
        : null,
    );
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    onInteractionChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointerX = Math.round(event.clientX);
    const pointerY = Math.round(event.clientY);
    const next = {
      pointerId: event.pointerId,
      startX: pointerX,
      startY: pointerY,
      currentX: pointerX,
      currentY: pointerY,
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
    };
    marqueeSession.current = next;
    setMarquee(next);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = marqueeSession.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const pointer = { x: event.clientX, y: event.clientY };
    const next = {
      ...active,
      currentX: Math.round(pointer.x),
      currentY: Math.round(pointer.y),
      intent: updatePointerDrag(active.intent, pointer),
    };
    marqueeSession.current = next;
    setMarquee(next);
    if (next.intent.phase !== 'dragging') return;
    const selection: Rectangle = {
      left: Math.min(next.startX, next.currentX),
      top: Math.min(next.startY, next.currentY),
      right: Math.max(next.startX, next.currentX),
      bottom: Math.max(next.startY, next.currentY),
    };
    const icons = [
      ...(surface.current?.querySelectorAll<HTMLElement>('[data-desktop-icon]') ?? []),
    ].flatMap((element) => {
      const id = element.dataset.desktopIcon;
      if (!id) return [];
      const bounds = element.getBoundingClientRect();
      return [
        {
          id,
          bounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
          },
        },
      ];
    });
    onMarquee(desktopIconIdsInRectangle(selection, icons));
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = marqueeSession.current;
    if (!active || active.pointerId !== event.pointerId) return;
    marqueeSession.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMarquee(null);
    onInteractionChange(false);
    if (releasePointerDrag(active.intent) === 'click') onBackgroundClick();
  };

  const pointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = marqueeSession.current;
    if (!active || active.pointerId !== event.pointerId) return;
    marqueeSession.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMarquee(null);
    onInteractionChange(false);
  };

  const lostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = marqueeSession.current;
    if (!active || active.pointerId !== event.pointerId) return;
    marqueeSession.current = null;
    setMarquee(null);
    onInteractionChange(false);
  };

  const bounds =
    marquee?.intent.phase === 'dragging'
      ? {
          left: Math.min(marquee.startX, marquee.currentX),
          top: Math.min(marquee.startY, marquee.currentY) - 24,
          width: Math.abs(marquee.currentX - marquee.startX),
          height: Math.abs(marquee.currentY - marquee.startY),
        }
      : null;

  return (
    <div
      className="desktop-surface"
      data-drop-destination="desktop"
      data-icon-layout-parent="desktop"
      data-vfs-count={vfsCount}
      onDragEnd={() => {
        clearDropTarget();
        onInteractionChange(false);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof HTMLElement) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          clearDropTarget();
          onInteractionChange(false);
        }
      }}
      onDragOver={dragOver}
      onDrop={drop}
      onLostPointerCapture={lostPointerCapture}
      onPointerCancel={pointerCancel}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      ref={surface}
    >
      {children}
      {bounds && bounds.width > 2 && bounds.height > 2 && (
        <div className="selection-marquee" style={bounds} />
      )}
    </div>
  );
}
