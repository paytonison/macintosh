import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { Point } from '../../shared/state';
import { desktopIconIdsInRectangle } from '../model/desktop-icon-layout';
import { isTrashDropPoint } from '../model/desktop-drop-target';
import type { Rectangle } from '../../shared/vfs';
import { VFS_DRAG_TYPE } from '../model/vfs-drag';

export interface IconDropLocation {
  parentId: string;
  point: Point;
  surfaceSize: { width: number; height: number };
}

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
      if (surface.current?.hasPointerCapture(active.pointerId)) {
        surface.current.releasePointerCapture(active.pointerId);
      }
      marqueeSession.current = null;
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

  const resolveDropTarget = (
    target: EventTarget | null,
    external: boolean,
    pointer: Point,
  ): { destinationId: string; element: HTMLElement } | null => {
    let element = target instanceof Element ? target : null;
    while (element && surface.current?.contains(element)) {
      if (element instanceof HTMLElement) {
        const destinationId = element.dataset.dropDestination;
        if (destinationId) {
          if (external && element.dataset.dropMode === 'internal') return null;
          if (element.dataset.desktopIcon === 'trash' && !isTrashDropPoint(pointer, element)) {
            return null;
          }
          return { destinationId, element };
        }
        if (element.dataset.dropBlocked === 'true') return null;
      }
      element = element.parentElement;
    }
    return null;
  };

  const parseNodeIds = (dataTransfer: DataTransfer): string[] => {
    try {
      const value = JSON.parse(dataTransfer.getData(VFS_DRAG_TYPE)) as unknown;
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').slice(0, 512)
        : [];
    } catch {
      return [];
    }
  };

  const dragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    const internal = event.dataTransfer.types.includes(VFS_DRAG_TYPE);
    const external = !internal && event.dataTransfer.types.includes('Files');
    if (!external && !internal) return;
    onInteractionChange(true);
    const target = resolveDropTarget(event.target, external, {
      x: event.clientX,
      y: event.clientY,
    });
    if (!target) {
      clearDropTarget();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = external ? 'copy' : 'move';
    if (highlightedDropTarget.current !== target.element) {
      clearDropTarget();
      highlightedDropTarget.current = target.element;
      target.element.classList.add('is-file-drop-target');
    }
  };

  const drop = (event: ReactDragEvent<HTMLDivElement>): void => {
    onInteractionChange(false);
    const nodeIds = parseNodeIds(event.dataTransfer);
    const files = Array.from(event.dataTransfer.files);
    const target = resolveDropTarget(event.target, nodeIds.length === 0 && files.length > 0, {
      x: event.clientX,
      y: event.clientY,
    });
    clearDropTarget();
    if (!target || (nodeIds.length === 0 && files.length === 0)) return;
    event.preventDefault();
    event.stopPropagation();
    const layoutParent = target.element.dataset.iconLayoutParent;
    const bounds = layoutParent ? target.element.getBoundingClientRect() : null;
    onDropItems(
      target.destinationId,
      nodeIds,
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
    };
    marqueeSession.current = next;
    setMarquee(next);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    const next = {
      ...marquee,
      currentX: Math.round(event.clientX),
      currentY: Math.round(event.clientY),
    };
    marqueeSession.current = next;
    setMarquee(next);
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
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      marquee.currentX - marquee.startX,
      marquee.currentY - marquee.startY,
    );
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    marqueeSession.current = null;
    setMarquee(null);
    onInteractionChange(false);
    if (distance < 4) onBackgroundClick();
  };

  const pointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    marqueeSession.current = null;
    setMarquee(null);
    onInteractionChange(false);
  };

  const bounds = marquee
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
