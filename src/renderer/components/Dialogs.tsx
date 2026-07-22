import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { VfsNode } from '../../shared/state';
import { PixelIcon } from './PixelIcon';

interface ClassicDialogProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

function ClassicDialog({ title, children, onClose, width = 430 }: ClassicDialogProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<DragState | null>(null);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setOffset({
      x: Math.round(active.originX + event.clientX - active.startX),
      y: Math.round(active.originY + event.clientY - active.startY),
    });
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
  };

  return (
    <section
      aria-label={title}
      aria-modal="true"
      className="classic-dialog"
      role="dialog"
      style={{ marginLeft: offset.x, marginTop: offset.y, width }}
    >
      <div
        className="dialog-titlebar"
        onPointerCancel={pointerUp}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
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
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <ClassicDialog onClose={onClose} title="About This Macintosh" width={456}>
      <div className="about-content">
        <PixelIcon name="computer" size={64} />
        <div className="about-copy">
          <h3>Macintosh Workbench</h3>
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

export function InfoDialog({ node, onClose }: { node: VfsNode; onClose: () => void }) {
  return (
    <ClassicDialog onClose={onClose} title={`${node.name} Info`} width={384}>
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
            <dd>System Disk</dd>
          </div>
          <div>
            <dt>Created:</dt>
            <dd>{new Date(node.createdAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      </div>
      <div className="dialog-actions">
        <button className="classic-default-button" onClick={onClose} type="button">
          OK
        </button>
      </div>
    </ClassicDialog>
  );
}

export function EjectTipDialog({ onClose }: { onClose: () => void }) {
  return (
    <ClassicDialog onClose={onClose} title="Eject System Disk" width={420}>
      <div className="message-content">
        <PixelIcon name="disk" size={48} />
        <p>Drag System Disk onto Trash to eject it and shut down Macintosh Workbench.</p>
      </div>
      <div className="dialog-actions">
        <button className="classic-default-button" onClick={onClose} type="button">
          OK
        </button>
      </div>
    </ClassicDialog>
  );
}
