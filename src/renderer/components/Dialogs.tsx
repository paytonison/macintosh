import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { VfsNode } from '../../shared/state';
import { beginPointerDrag, updatePointerDrag, type PointerDragIntent } from '../model/pointer-drag';
import { PixelIcon } from './PixelIcon';

interface ClassicDialogProps {
  title: string;
  children: ReactNode;
  interactionCancelToken: number;
  onClose: () => void;
  onInteractionChange: (active: boolean) => void;
  width?: number;
}

interface DragState {
  pointerId: number;
  captureTarget: HTMLDivElement;
  originX: number;
  originY: number;
  intent: PointerDragIntent;
}

interface ModalLayerProps {
  children: ReactNode;
  kind: 'dialog' | 'persistence-alert';
  onClose: () => void;
  persistenceAlert?: boolean;
}

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function ModalLayer({ children, kind, onClose, persistenceAlert = false }: ModalLayerProps) {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const current = layer.current;
    if (!current?.contains(document.activeElement)) {
      current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    }
  }, []);

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector),
    ).filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={`modal-layer ${persistenceAlert ? 'persistence-alert-layer' : ''}`.trim()}
      data-drop-blocked="true"
      data-modal-layer={kind}
      onKeyDown={keyDown}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      ref={layer}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

function ClassicDialog({
  title,
  children,
  interactionCancelToken,
  onClose,
  onInteractionChange,
  width = 430,
}: ClassicDialogProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);

  useLayoutEffect(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.captureTarget.hasPointerCapture(active.pointerId)) {
      active.captureTarget.releasePointerCapture(active.pointerId);
    }
    setOffset({ x: active.originX, y: active.originY });
    setDragging(false);
    onInteractionChange(false);
  }, [interactionCancelToken, onInteractionChange]);

  useEffect(
    () => () => {
      if (!drag.current) return;
      drag.current = null;
      onInteractionChange(false);
    },
    [onInteractionChange],
  );

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    onInteractionChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      originX: offset.x,
      originY: offset.y,
      intent: beginPointerDrag({ x: event.clientX, y: event.clientY }),
    };
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.intent = updatePointerDrag(active.intent, {
      x: event.clientX,
      y: event.clientY,
    });
    if (active.intent.phase !== 'dragging') return;
    setDragging(true);
    setOffset({
      x: Math.round(active.originX + event.clientX - active.intent.origin.x),
      y: Math.round(active.originY + event.clientY - active.intent.origin.y),
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!commit) setOffset({ x: active.originX, y: active.originY });
    setDragging(false);
    onInteractionChange(false);
  };

  const lostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    setOffset({ x: active.originX, y: active.originY });
    setDragging(false);
    onInteractionChange(false);
  };

  return (
    <ModalLayer kind="dialog" onClose={onClose}>
      <section
        aria-label={title}
        aria-modal="true"
        className={`classic-dialog ${dragging ? 'is-dragging' : ''}`.trim()}
        role="dialog"
        style={{ marginLeft: offset.x, marginTop: offset.y, width }}
      >
        <div
          className="dialog-titlebar"
          onLostPointerCapture={lostPointerCapture}
          onPointerCancel={(event) => finishDrag(event, false)}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={(event) => finishDrag(event, true)}
        >
          <button
            aria-label={`Close ${title}`}
            className="dialog-close"
            onClick={onClose}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          />
          <h2>{title}</h2>
        </div>
        {children}
      </section>
    </ModalLayer>
  );
}

interface MovableDialogProps {
  interactionCancelToken: number;
  onClose: () => void;
  onInteractionChange: (active: boolean) => void;
}

export function AboutDialog({
  interactionCancelToken,
  onClose,
  onInteractionChange,
}: MovableDialogProps) {
  return (
    <ClassicDialog
      interactionCancelToken={interactionCancelToken}
      onClose={onClose}
      onInteractionChange={onInteractionChange}
      title="About This Macintosh"
      width={456}
    >
      <div className="about-content">
        <PixelIcon name="computer" size={64} />
        <div className="about-copy">
          <h3>The Macintosh</h3>
          <p>System Software 1.0</p>
          <p>© 2026 Payton Ison</p>
        </div>
      </div>
      <div className="about-rule" />
      <dl className="memory-table">
        <div>
          <dt>Built-in Memory:</dt>
          <dd>128K</dd>
        </div>
        <div>
          <dt>System Software:</dt>
          <dd>42K</dd>
        </div>
        <div>
          <dt>Largest Unused Block:</dt>
          <dd>86K</dd>
        </div>
      </dl>
      <div className="dialog-actions">
        <button autoFocus className="classic-default-button" onClick={onClose} type="button">
          OK
        </button>
      </div>
    </ClassicDialog>
  );
}

export function InfoDialog({
  interactionCancelToken,
  node,
  onClose,
  onInteractionChange,
  where,
}: MovableDialogProps & { node: VfsNode; where: string }) {
  return (
    <ClassicDialog
      interactionCancelToken={interactionCancelToken}
      onClose={onClose}
      onInteractionChange={onInteractionChange}
      title={`${node.name} Info`}
      width={384}
    >
      <div className="info-content">
        <PixelIcon
          name={node.kind === 'document' ? 'document' : node.kind === 'disk' ? 'disk' : 'folder'}
          size={48}
        />
        <dl>
          <div>
            <dt>Kind:</dt>
            <dd>{node.kind === 'disk' ? 'System disk' : node.kind}</dd>
          </div>
          <div>
            <dt>Where:</dt>
            <dd>{where}</dd>
          </div>
          <div>
            <dt>Created:</dt>
            <dd>{new Date(node.createdAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      </div>
      <div className="dialog-actions">
        <button autoFocus className="classic-default-button" onClick={onClose} type="button">
          OK
        </button>
      </div>
    </ClassicDialog>
  );
}

export function EjectTipDialog({
  interactionCancelToken,
  onClose,
  onInteractionChange,
}: MovableDialogProps) {
  return (
    <ClassicDialog
      interactionCancelToken={interactionCancelToken}
      onClose={onClose}
      onInteractionChange={onInteractionChange}
      title="Eject System Disk"
      width={420}
    >
      <div className="message-content">
        <PixelIcon name="disk" size={48} />
        <p>Drag System Disk onto Trash to eject it and shut down The Macintosh.</p>
      </div>
      <div className="dialog-actions">
        <button autoFocus className="classic-default-button" onClick={onClose} type="button">
          OK
        </button>
      </div>
    </ClassicDialog>
  );
}

export function PersistenceAlert({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <ModalLayer kind="persistence-alert" onClose={onClose} persistenceAlert>
      <section
        aria-label="Persistence error"
        aria-modal="true"
        className="save-error"
        role="alertdialog"
      >
        <span>{message}</span>
        <button autoFocus onClick={onClose} type="button">
          OK
        </button>
      </section>
    </ModalLayer>
  );
}
