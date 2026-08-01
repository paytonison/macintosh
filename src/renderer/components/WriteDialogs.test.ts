import { describe, expect, it } from 'vitest';

import { createDefaultState, type VfsNode } from '../../shared/state';
import {
  isWriteDialogNodeInsideTrash,
  writeDialogDefaultFolderId,
  writeDialogEnclosingFolder,
  writeDialogVisibleChildren,
} from './WriteDialogs';

const timestamp = '2026-07-31T12:00:00.000Z';

const folder = (id: string, parentId: string, name: string): VfsNode => ({
  id,
  parentId,
  name,
  kind: 'folder',
  createdAt: timestamp,
  modifiedAt: timestamp,
});

describe('Write virtual-file dialog navigation', () => {
  it('starts in a valid Documents folder and falls back to System Disk otherwise', () => {
    const state = createDefaultState();
    expect(writeDialogDefaultFolderId(state.nodes)).toBe('documents');
    expect(writeDialogEnclosingFolder(state.nodes, 'documents')?.id).toBe('system-disk');

    const documents = state.nodes.find((node) => node.id === 'documents');
    if (!documents) throw new Error('Missing Documents fixture.');
    documents.parentId = 'trash';
    expect(writeDialogDefaultFolderId(state.nodes)).toBe('system-disk');

    documents.parentId = 'system-disk';
    documents.kind = 'document';
    expect(writeDialogDefaultFolderId(state.nodes)).toBe('system-disk');

    state.nodes = state.nodes.filter((node) => node.id !== 'documents');
    expect(writeDialogDefaultFolderId(state.nodes)).toBe('system-disk');
  });

  it('excludes Trash and every descendant from both dialog modes', () => {
    const state = createDefaultState();
    const documents = state.nodes.find((node) => node.id === 'documents');
    if (!documents) throw new Error('Missing Documents fixture.');
    documents.parentId = 'trash';
    const nestedFolder = folder('trash-nested-folder', 'documents', 'Nested Folder');
    const nestedDocument: VfsNode = {
      id: 'trash-nested-document',
      parentId: nestedFolder.id,
      name: 'Nested Document',
      kind: 'document',
      payload: { format: 'plain-text', text: 'hidden' },
      createdAt: timestamp,
      modifiedAt: timestamp,
    };
    state.nodes.push(nestedFolder, nestedDocument);

    expect(isWriteDialogNodeInsideTrash(state.nodes, documents)).toBe(true);
    expect(isWriteDialogNodeInsideTrash(state.nodes, nestedFolder)).toBe(true);
    expect(isWriteDialogNodeInsideTrash(state.nodes, nestedDocument)).toBe(true);
    expect(writeDialogEnclosingFolder(state.nodes, 'documents')).toBeUndefined();
    expect(writeDialogEnclosingFolder(state.nodes, nestedFolder.id)).toBeUndefined();
    expect(writeDialogVisibleChildren(state.nodes, 'trash', 'open')).toEqual([]);
    expect(writeDialogVisibleChildren(state.nodes, 'documents', 'save-as')).toEqual([]);
    expect(writeDialogVisibleChildren(state.nodes, nestedFolder.id, 'open')).toEqual([]);
  });

  it('shows folders in both modes and documents only when opening', () => {
    const state = createDefaultState();
    const nestedFolder = folder('documents-folder', 'documents', 'Folder');
    state.nodes.push(nestedFolder);
    const openItems = writeDialogVisibleChildren(state.nodes, 'documents', 'open');
    const saveItems = writeDialogVisibleChildren(state.nodes, 'documents', 'save-as');

    expect(openItems).toContain(nestedFolder);
    expect(openItems.some((node) => node.kind === 'document')).toBe(true);
    expect(saveItems).toEqual([nestedFolder]);
  });
});
