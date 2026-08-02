import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { Point, WindowGeometry } from '../../shared/state';
import {
  committedWindowGeometry,
  previewWindowMove,
  previewWindowResize,
  windowAnimationGeometryFrames,
  type ClassicWindowConstraints,
} from '../model/classic-window';
import {
  beginPointerDrag,
  releasePointerDrag,
  updatePointerDrag,
  type PointerDragIntent,
} from '../model/pointer-drag';

export interface ClassicWindowAnimation {
  phase: 'opening' | 'closing';
  origin: Point | null;
  token: number;
}

interface GeometrySession {
  kind: 'move' | 'resize';
  pointerId: number;
  captureTarget: HTMLElement;
  original: WindowGeometry;
  current: WindowGeometry;
  intent: PointerDragIntent;
}

interface ClassicWindowFrameControls {
  growBox: ReactElement;
}

interface ClassicWindowFrameProps {
  active: boolean;
  animation?: ClassicWindowAnimation;
  ariaLabel: string;
  children: ReactNode | ((controls: ClassicWindowFrameControls) => ReactNode);
  className?: string;
  controlLabel: string;
  dataAttributes?: Record<string, string | undefined>;
  geometry: WindowGeometry;
  interactionCancelToken: number;
  minimumHeight: number;
  minimumWidth: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onGeometry: (id: string, geometry: WindowGeometry) => void;
  onInteractionChange: (active: boolean) => void;
  onZoom: (id: string) => void;
  title: ReactNode;
  titleBarClassName?: string;
  growBoxClassName?: string;
  windowId: string;
  zIndex: number;
}

interface ClassicWindowAnimationShadowProps {
  animation: ClassicWindowAnimation;
  geometry: WindowGeometry;
  onAnimationComplete: (id: string, phase: ClassicWindowAnimation['phase'], token: number) => void;
  windowId: string;
  zIndex: number;
}

export const shouldCancelClassicWindowCapture = (
  activePointerId: number | null,
  lostPointerId: number,
): boolean => activePointerId === lostPointerId;

const animationGeometry = (
  geometry: WindowGeometry,
  animation: ClassicWindowAnimation,
): CSSProperties => {
  const frames = windowAnimationGeometryFrames(geometry, animation.origin);
  const properties: Record<string, string> = {
    '--window-animation-start-x': `${frames[0].x}px`,
    '--window-animation-start-y': `${frames[0].y}px`,
    '--window-animation-start-width': `${frames[0].width}px`,
    '--window-animation-start-height': `${frames[0].height}px`,
    '--window-animation-end-x': `${frames[6].x}px`,
    '--window-animation-end-y': `${frames[6].y}px`,
    '--window-animation-end-width': `${frames[6].width}px`,
    '--window-animation-end-height': `${frames[6].height}px`,
  };
  frames.forEach((frame, index) => {
    properties[`--window-animation-frame-${index}-x`] = `${frame.x}px`;
    properties[`--window-animation-frame-${index}-y`] = `${frame.y}px`;
    properties[`--window-animation-frame-${index}-width`] = `${frame.width}px`;
    properties[`--window-animation-frame-${index}-height`] = `${frame.height}px`;
  });
  return properties as CSSProperties;
};

export function ClassicWindowAnimationShadow({
  animation,
  geometry,
  onAnimationComplete,
  windowId,
  zIndex,
}: ClassicWindowAnimationShadowProps) {
  const outline = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const automation = Boolean(outline.current?.closest('.macintosh.is-automation'));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(
      () => onAnimationComplete(windowId, animation.phase, animation.token),
      automation ? 300 : reducedMotion ? 40 : 260,
    );
    return () => window.clearTimeout(timer);
  }, [animation, onAnimationComplete, windowId]);

  return (
    <div
      aria-hidden="true"
      className={`window-animation-shadow is-${animation.phase}`}
      data-window-animation-shadow={windowId}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        const phase =
          event.animationName === 'finder-window-open'
            ? 'opening'
            : event.animationName === 'finder-window-close'
              ? 'closing'
              : null;
        if (phase) onAnimationComplete(windowId, phase, animation.token);
      }}
      ref={outline}
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
        zIndex,
        ...animationGeometry(geometry, animation),
      }}
    >
      <span />
    </div>
  );
}

export function ClassicWindowFrame({
  active,
  animation,
  ariaLabel,
  children,
  className,
  controlLabel,
  dataAttributes,
  geometry,
  interactionCancelToken,
  minimumHeight,
  minimumWidth,
  onActivate,
  onClose,
  onGeometry,
  onInteractionChange,
  onZoom,
  title,
  titleBarClassName,
  growBoxClassName,
  windowId,
  zIndex,
}: ClassicWindowFrameProps) {
  const frame = useRef<HTMLElement>(null);
  const dragShadow = useRef<HTMLDivElement>(null);
  const session = useRef<GeometrySession | null>(null);
  const releaseCleanup = useRef<(() => void) | null>(null);
  const finishGeometryRef = useRef<(pointerId: number, commit: boolean) => void>(() => {});
  const callbacks = useRef({ onActivate, onGeometry, onInteractionChange });
  const constraints = useRef<ClassicWindowConstraints>({
    minWidth: minimumWidth,
    minHeight: minimumHeight,
  });

  useLayoutEffect(() => {
    callbacks.current = { onActivate, onGeometry, onInteractionChange };
    constraints.current = { minWidth: minimumWidth, minHeight: minimumHeight };
  }, [minimumHeight, minimumWidth, onActivate, onGeometry, onInteractionChange]);

  const clearGeometryPreview = (): void => {
    frame.current?.classList.remove('is-shadow-dragging', 'is-shadow-resizing');
    if (frame.current) {
      delete frame.current.dataset.windowDragging;
      delete frame.current.dataset.windowResizing;
    }
    if (dragShadow.current) {
      dragShadow.current.style.transform = 'translate3d(0, 0, 0)';
      dragShadow.current.style.removeProperty('width');
      dragShadow.current.style.removeProperty('height');
    }
  };

  const removeReleaseListeners = (): void => {
    releaseCleanup.current?.();
    releaseCleanup.current = null;
  };

  const finishGeometry = (pointerId: number, commit: boolean): void => {
    const activeSession = session.current;
    if (!activeSession || activeSession.pointerId !== pointerId) return;
    session.current = null;
    removeReleaseListeners();
    if (activeSession.captureTarget.hasPointerCapture(pointerId)) {
      activeSession.captureTarget.releasePointerCapture(pointerId);
    }
    clearGeometryPreview();
    callbacks.current.onInteractionChange(false);

    const committed = committedWindowGeometry(
      activeSession.original,
      activeSession.current,
      releasePointerDrag(activeSession.intent) === 'drag',
      commit,
    );
    if (committed) callbacks.current.onGeometry(windowId, committed);
  };
  useLayoutEffect(() => {
    finishGeometryRef.current = finishGeometry;
  });

  const watchRelease = (pointerId: number): void => {
    removeReleaseListeners();
    const pointerUp = (event: PointerEvent): void => {
      if (event.pointerId === pointerId) finishGeometryRef.current(pointerId, true);
    };
    const pointerCancel = (event: PointerEvent): void => {
      if (event.pointerId === pointerId) finishGeometryRef.current(pointerId, false);
    };
    const blur = (): void => finishGeometryRef.current(pointerId, false);
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerCancel, true);
    window.addEventListener('blur', blur);
    releaseCleanup.current = () => {
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointercancel', pointerCancel, true);
      window.removeEventListener('blur', blur);
    };
  };

  const beginGeometry = (
    event: ReactPointerEvent<HTMLElement>,
    kind: GeometrySession['kind'],
  ): void => {
    if (event.button !== 0 || session.current) return;
    event.preventDefault();
    event.stopPropagation();
    callbacks.current.onActivate(windowId);
    callbacks.current.onInteractionChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const committedGeometry = {
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
    };
    session.current = {
      kind,
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      original: committedGeometry,
      current: committedGeometry,
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
    };
    clearGeometryPreview();
    watchRelease(event.pointerId);
  };

  const moveGeometry = (event: ReactPointerEvent<HTMLElement>): void => {
    const activeSession = session.current;
    if (!activeSession || activeSession.pointerId !== event.pointerId) return;
    activeSession.intent = updatePointerDrag(activeSession.intent, {
      x: event.clientX,
      y: event.clientY,
    });
    if (activeSession.intent.phase !== 'dragging') return;

    const surface = frame.current?.closest<HTMLElement>('.desktop-surface');
    const surfaceSize = {
      width: surface?.clientWidth ?? window.innerWidth,
      height: surface?.clientHeight ?? window.innerHeight - 22,
    };
    const pointer = { x: event.clientX, y: event.clientY };
    activeSession.current =
      activeSession.kind === 'move'
        ? previewWindowMove(
            activeSession.original,
            activeSession.intent.origin,
            pointer,
            surfaceSize,
            constraints.current,
          )
        : previewWindowResize(
            activeSession.original,
            activeSession.intent.origin,
            pointer,
            surfaceSize,
            constraints.current,
          );

    if (activeSession.kind === 'move') {
      frame.current?.classList.add('is-shadow-dragging');
      if (frame.current) frame.current.dataset.windowDragging = 'true';
      if (dragShadow.current) {
        dragShadow.current.style.transform = `translate3d(${activeSession.current.x - activeSession.original.x}px, ${activeSession.current.y - activeSession.original.y}px, 0)`;
      }
    } else {
      frame.current?.classList.add('is-shadow-resizing');
      if (frame.current) frame.current.dataset.windowResizing = 'true';
      if (dragShadow.current) {
        dragShadow.current.style.width = `${activeSession.current.width}px`;
        dragShadow.current.style.height = `${activeSession.current.height}px`;
      }
    }
  };

  const loseCapture = (event: ReactPointerEvent<HTMLElement>): void => {
    const activeSession = session.current;
    if (!shouldCancelClassicWindowCapture(activeSession?.pointerId ?? null, event.pointerId)) {
      return;
    }
    finishGeometry(event.pointerId, false);
  };

  useLayoutEffect(() => {
    const activeSession = session.current;
    if (activeSession) finishGeometryRef.current(activeSession.pointerId, false);
  }, [animation?.token, interactionCancelToken, windowId]);

  useEffect(
    () => () => {
      const activeSession = session.current;
      session.current = null;
      removeReleaseListeners();
      if (activeSession?.captureTarget.hasPointerCapture(activeSession.pointerId)) {
        activeSession.captureTarget.releasePointerCapture(activeSession.pointerId);
      }
      if (activeSession) callbacks.current.onInteractionChange(false);
    },
    [],
  );

  const frameStyle = {
    left: geometry.x,
    top: geometry.y,
    width: geometry.width,
    height: geometry.height,
    zIndex,
  } as CSSProperties;
  const frameClassName = [
    'finder-window',
    'classic-window-frame',
    className,
    active ? 'is-active' : 'is-inactive',
    animation ? `is-${animation.phase}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const growBox = (
    <button
      aria-label={`Resize ${controlLabel}`}
      className={['window-grow-box', growBoxClassName].filter(Boolean).join(' ')}
      onLostPointerCapture={loseCapture}
      onPointerCancel={(event) => finishGeometry(event.pointerId, false)}
      onPointerDown={(event) => beginGeometry(event, 'resize')}
      onPointerMove={moveGeometry}
      onPointerUp={(event) => finishGeometry(event.pointerId, true)}
      type="button"
    />
  );

  return (
    <section
      {...dataAttributes}
      aria-label={ariaLabel}
      className={frameClassName}
      data-closing={animation?.phase === 'closing' ? 'true' : undefined}
      data-opening={animation?.phase === 'opening' ? 'true' : undefined}
      onPointerDown={() => callbacks.current.onActivate(windowId)}
      ref={frame}
      style={frameStyle}
    >
      <div aria-hidden="true" className="window-drag-shadow" ref={dragShadow}>
        <span />
      </div>
      <header
        className={['window-titlebar', titleBarClassName].filter(Boolean).join(' ')}
        data-window-drag-handle="true"
        onDoubleClick={(event) => {
          if ((event.target as Element).closest('button')) return;
          onZoom(windowId);
        }}
        onLostPointerCapture={loseCapture}
        onPointerCancel={(event) => finishGeometry(event.pointerId, false)}
        onPointerDown={(event) => beginGeometry(event, 'move')}
        onPointerMove={moveGeometry}
        onPointerUp={(event) => finishGeometry(event.pointerId, true)}
      >
        <button
          aria-label={`Close ${controlLabel}`}
          className="window-close"
          onClick={(event) => {
            event.stopPropagation();
            onClose(windowId);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            event.stopPropagation();
            callbacks.current.onActivate(windowId);
          }}
          type="button"
        />
        <h2>{title}</h2>
        <button
          aria-label={`Zoom ${controlLabel}`}
          className="window-zoom"
          onClick={(event) => {
            event.stopPropagation();
            onZoom(windowId);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            event.stopPropagation();
            callbacks.current.onActivate(windowId);
          }}
          type="button"
        />
      </header>
      {typeof children === 'function' ? children({ growBox }) : children}
    </section>
  );
}
