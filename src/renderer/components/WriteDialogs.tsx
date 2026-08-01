import { useMemo, useState } from 'react';

import type { VfsNode } from '../../shared/state';
import { VfsNodeIcon } from './VfsNodeIcon';
import { ClassicDialog } from './Dialogs';

interface DialogInteractionProps {
  interactionCancelToken: number;
  onInteractionChange: (active: boolean) => void;
}

interface UnsavedChangesDialogProps extends DialogInteractionProps {
  title: string;
  detail?: string;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function UnsavedChangesDialog({
  title,
  detail,
  saving,
  interactionCancelToken,
  onInteractionChange,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  return (
    <ClassicDialog
      interactionCancelToken={interactionCancelToken}
      onClose={onCancel}
      onInteractionChange={onInteractionChange}
      title="Save Changes"
      width={470}
    >
      <div className="write-save-message">
        <strong>Save changes to “{title}”?</strong>
        <p>{detail ?? 'Your changes will be lost if you do not save them.'}</p>
      </div>
      <div className="dialog-actions write-save-actions">
        <button disabled={saving} onClick={onDiscard} type="button">
          Don’t Save
        </button>
        <button disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          autoFocus
          className="classic-default-button"
          disabled={saving}
          onClick={onSave}
          type="button"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </ClassicDialog>
  );
}

export type VirtualFileDialogMode = 'open' | 'save-as';

interface VirtualFileDialogProps extends DialogInteractionProps {
  mode: VirtualFileDialogMode;
  nodes: VfsNode[];
  initialName?: string;
  saving?: boolean;
  onCancel: () => void;
  onOpen: (nodeId: string) => void;
  onSave: (parentId: string, name: string) => void;
}

export const isWriteDialogNodeInsideTrash = (nodes: readonly VfsNode[], node: VfsNode): boolean => {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current: VfsNode | undefined = node;
  while (current && !seen.has(current.id)) {
    if (current.id === 'trash') return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
};

export const writeDialogDefaultFolderId = (nodes: readonly VfsNode[]): string => {
  const documentsFolder = nodes.find((node) => node.id === 'documents');
  return documentsFolder?.kind === 'folder' && !isWriteDialogNodeInsideTrash(nodes, documentsFolder)
    ? documentsFolder.id
    : 'system-disk';
};

export const writeDialogVisibleChildren = (
  nodes: readonly VfsNode[],
  folderId: string,
  mode: VirtualFileDialogMode,
): VfsNode[] =>
  nodes
    .filter(
      (node) =>
        node.parentId === folderId &&
        !isWriteDialogNodeInsideTrash(nodes, node) &&
        (node.kind === 'folder' || (mode === 'open' && node.kind === 'document')),
    )
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

export const writeDialogEnclosingFolder = (
  nodes: readonly VfsNode[],
  folderId: string,
): VfsNode | undefined => {
  const currentFolder = nodes.find((node) => node.id === folderId);
  const parent = currentFolder?.parentId
    ? nodes.find((node) => node.id === currentFolder.parentId)
    : undefined;
  return parent && parent.id !== 'trash' && !isWriteDialogNodeInsideTrash(nodes, parent)
    ? parent
    : undefined;
};

export function VirtualFileDialog({
  mode,
  nodes,
  initialName = 'Untitled',
  saving = false,
  interactionCancelToken,
  onInteractionChange,
  onCancel,
  onOpen,
  onSave,
}: VirtualFileDialogProps) {
  const defaultFolder = writeDialogDefaultFolderId(nodes);
  const [folderId, setFolderId] = useState(defaultFolder);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState(initialName);
  const currentFolder = nodes.find((node) => node.id === folderId);
  const children = useMemo(
    () => writeDialogVisibleChildren(nodes, folderId, mode),
    [folderId, mode, nodes],
  );
  const selected = nodes.find((node) => node.id === selectedId);
  const parent = writeDialogEnclosingFolder(nodes, folderId);
  const canGoUp = Boolean(parent);

  const openSelected = (): void => {
    if (!selected) return;
    if (selected.kind === 'folder') {
      setFolderId(selected.id);
      setSelectedId(null);
    } else if (selected.kind === 'document') {
      onOpen(selected.id);
    }
  };

  return (
    <ClassicDialog
      interactionCancelToken={interactionCancelToken}
      onClose={onCancel}
      onInteractionChange={onInteractionChange}
      title={mode === 'open' ? 'Open' : 'Save As'}
      width={520}
    >
      <div className="write-file-dialog" data-write-file-dialog={mode}>
        <div className="write-file-location">
          <button
            aria-label="Open enclosing folder"
            disabled={!canGoUp || saving}
            onClick={() => {
              if (!parent) return;
              setFolderId(parent.id);
              setSelectedId(null);
            }}
            type="button"
          >
            ↑
          </button>
          <strong data-write-file-location>{currentFolder?.name ?? 'Documents'}</strong>
        </div>
        <div aria-label="Virtual disk items" className="write-file-list" role="listbox">
          {children.length === 0 ? (
            <p className="write-file-empty">This folder is empty.</p>
          ) : (
            children.map((node) => (
              <button
                aria-selected={selectedId === node.id}
                className={selectedId === node.id ? 'is-selected' : ''}
                disabled={saving}
                key={node.id}
                onClick={() => {
                  setSelectedId(node.id);
                  if (mode === 'save-as' && node.kind === 'document') setName(node.name);
                }}
                onDoubleClick={() => {
                  if (node.kind === 'folder') {
                    setFolderId(node.id);
                    setSelectedId(null);
                  } else {
                    onOpen(node.id);
                  }
                }}
                role="option"
                type="button"
              >
                <VfsNodeIcon node={node} size={24} />
                <span>{node.name}</span>
              </button>
            ))
          )}
        </div>
        {mode === 'save-as' ? (
          <label className="write-file-name">
            <span>Save document as:</span>
            <input
              autoFocus
              disabled={saving}
              maxLength={96}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim() && !saving) onSave(folderId, name);
              }}
              value={name}
            />
          </label>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
        {mode === 'open' ? (
          <button
            className="classic-default-button"
            disabled={!selected}
            onClick={openSelected}
            type="button"
          >
            {selected?.kind === 'folder' ? 'Open Folder' : 'Open'}
          </button>
        ) : (
          <button
            className="classic-default-button"
            disabled={!name.trim() || saving}
            onClick={() => onSave(folderId, name)}
            type="button"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </ClassicDialog>
  );
}
