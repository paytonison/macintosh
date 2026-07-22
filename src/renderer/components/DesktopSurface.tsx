import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { rectanglesOverlap, type Rectangle } from '../model/vfs';

interface DesktopSurfaceProps {
  children: ReactNode;
  vfsCount: number;
  onBackgroundClick: () => void;
  onMarquee: (ids: Array<'system-disk' | 'trash'>) => void;
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
  vfsCount,
  onBackgroundClick,
  onMarquee,
}: DesktopSurfaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarquee({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!marquee || marquee.pointerId !== event.pointerId) return;
    const next = { ...marquee, currentX: event.clientX, currentY: event.clientY };
    setMarquee(next);
    const selection: Rectangle = {
      left: Math.min(next.startX, next.currentX),
      top: Math.min(next.startY, next.currentY),
      right: Math.max(next.startX, next.currentX),
      bottom: Math.max(next.startY, next.currentY),
    };
    const ids: Array<'system-disk' | 'trash'> = [];
    surface.current?.querySelectorAll<HTMLElement>('[data-desktop-icon]').forEach((element) => {
      const bounds = element.getBoundingClientRect();
      if (
        rectanglesOverlap(selection, {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
        })
      ) {
        const id = element.dataset.desktopIcon;
        if (id === 'system-disk' || id === 'trash') ids.push(id);
      }
    });
    onMarquee(ids);
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
    setMarquee(null);
    if (distance < 4) onBackgroundClick();
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
      data-vfs-count={vfsCount}
      onPointerCancel={pointerUp}
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
