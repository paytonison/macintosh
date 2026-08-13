import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { canonicalCreatedAtForNodeId, type VfsNode } from '../../shared/state';
import { validateVfsRename, type VfsRenameValidation } from '../../shared/vfs';
import { beginPointerDrag, updatePointerDrag, type PointerDragIntent } from '../model/pointer-drag';
import { PixelIcon } from './PixelIcon';

export const formatInfoCreatedDate = (node: VfsNode): string => {
  const date = new Date(node.createdAt);
  if (canonicalCreatedAtForNodeId(node.id)) {
    return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
  }
  return date.toLocaleDateString();
};

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

export function ClassicDialog({
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
          name={
            node.kind === 'document'
              ? 'document'
              : node.kind === 'application'
                ? 'write'
                : node.kind === 'disk'
                  ? 'disk'
                  : 'folder'
          }
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
            <dd>{formatInfoCreatedDate(node)}</dd>
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

export const renameValidationMessage = (validation: VfsRenameValidation): string | null => {
  if (validation.ok) return null;
  switch (validation.reason) {
    case 'empty-name':
      return 'Enter a name.';
    case 'name-too-long':
      return 'Names can contain at most 96 characters.';
    case 'invalid-character':
      return 'Names cannot contain “/” or NUL characters.';
    case 'name-collision':
      return `An item named “${validation.name}” already exists in this folder.`;
    case 'missing-node':
    case 'unsupported-node':
      return 'This item can no longer be renamed.';
  }
};

interface RenameDialogProps extends MovableDialogProps {
  node: VfsNode;
  nodes: readonly VfsNode[];
  onRename: (name: string) => Promise<string | null>;
}

export function RenameDialog({
  interactionCancelToken,
  node,
  nodes,
  onClose,
  onInteractionChange,
  onRename,
}: RenameDialogProps) {
  const [name, setName] = useState(node.name);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const validation = validateVfsRename(nodes, node.id, name);
  const validationError = renameValidationMessage(validation);
  const error = validationError ?? submissionError;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const cancel = (): void => {
    if (!submittingRef.current) onClose();
  };

  const submit = async (): Promise<void> => {
    const latestValidation = validateVfsRename(nodes, node.id, name);
    if (!latestValidation.ok || submittingRef.current) return;
    if (latestValidation.name === latestValidation.node.name) {
      onClose();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    let failure: string | null;
    try {
      failure = await onRename(latestValidation.name);
    } catch {
      failure = 'The name could not be saved. Try again.';
    }
    if (!failure) return;
    submittingRef.current = false;
    setSubmissionError(failure);
    setSubmitting(false);
    requestAnimationFrame(() => input.current?.focus());
  };

  return (
    <ClassicDialog
      interactionCancelToken={interactionCancelToken}
      onClose={cancel}
      onInteractionChange={onInteractionChange}
      title="Rename"
      width={420}
    >
      <div className="rename-dialog-content">
        <label className="rename-name-field">
          <span>Name:</span>
          <input
            aria-describedby={error ? 'rename-name-error' : undefined}
            aria-invalid={error ? true : undefined}
            autoFocus
            disabled={submitting}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setSubmissionError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void submit();
            }}
            ref={input}
            value={name}
          />
        </label>
        {error ? (
          <p className="rename-name-error" id="rename-name-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions rename-dialog-actions">
        <button disabled={submitting} onClick={cancel} type="button">
          Cancel
        </button>
        <button
          className="classic-default-button"
          disabled={!validation.ok || submitting}
          onClick={() => void submit()}
          type="button"
        >
          {submitting ? 'Renaming…' : 'Rename'}
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

export function ResetDialog({
  interactionCancelToken,
  onCancel,
  onInteractionChange,
  onReset,
  resetting,
}: {
  interactionCancelToken: number;
  onCancel: () => void;
  onInteractionChange: (active: boolean) => void;
  onReset: () => void;
  resetting: boolean;
}) {
  const close = resetting ? () => undefined : onCancel;
  return (
    <ClassicDialog
      interactionCancelToken={interactionCancelToken}
      onClose={close}
      onInteractionChange={onInteractionChange}
      title="Reset Macintosh"
      width={460}
    >
      <div className="message-content reset-message-content">
        <PixelIcon name="disk" size={48} />
        <div>
          <p>
            Resetting restores the original Desktop, System Disk, Documents, and Trash shown when
            The Macintosh was new.
          </p>
          <p>
            Everything you created or changed will be permanently erased, including unsaved Write
            documents.
          </p>
        </div>
      </div>
      <div className="dialog-actions reset-dialog-actions">
        <button
          autoFocus
          className="classic-default-button"
          disabled={resetting}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button disabled={resetting} onClick={onReset} type="button">
          {resetting ? 'Resetting…' : 'Reset'}
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
