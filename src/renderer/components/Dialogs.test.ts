import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultState, type VfsNode } from '../../shared/state';
import { validateVfsRename } from '../../shared/vfs';
import {
  formatInfoCreatedDate,
  InfoDialog,
  RenameDialog,
  ResetDialog,
  renameValidationMessage,
} from './Dialogs';

describe('Reset dialog', () => {
  it('warns about permanent loss and keeps Cancel as the safe initial action', () => {
    const markup = renderToStaticMarkup(
      createElement(ResetDialog, {
        interactionCancelToken: 0,
        onCancel: () => undefined,
        onInteractionChange: () => undefined,
        onReset: () => undefined,
        resetting: false,
      }),
    );

    expect(markup).toContain('aria-label="Reset Macintosh"');
    expect(markup).toContain('permanently erased');
    expect(markup).toContain('including unsaved Write documents');
    expect(markup).toContain(
      '<button autofocus="" class="classic-default-button" type="button">Cancel</button>',
    );
    expect(markup).toContain('>Reset</button>');
  });

  it('locks both actions while the replacement is being committed', () => {
    const markup = renderToStaticMarkup(
      createElement(ResetDialog, {
        interactionCancelToken: 0,
        onCancel: () => undefined,
        onInteractionChange: () => undefined,
        onReset: () => undefined,
        resetting: true,
      }),
    );

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('Resetting…');
  });
});

describe('Get Info creation date', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['system-disk', '1/24/1984'],
    ['trash', '1/24/1984'],
    ['system-folder', '1/24/1984'],
    ['welcome', '1/24/1984'],
  ])('renders the canonical %s date exactly', (nodeId, expected) => {
    const node = createDefaultState().nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Missing ${nodeId} fixture.`);

    const markup = renderToStaticMarkup(
      createElement(InfoDialog, {
        interactionCancelToken: 0,
        node,
        onClose: () => undefined,
        onInteractionChange: () => undefined,
        where: 'Desktop',
      }),
    );

    expect(markup).toContain(`<dt>Created:</dt><dd>${expected}</dd>`);
  });

  it('does not consult the host locale for canonical built-ins', () => {
    const nodes = createDefaultState().nodes.filter((node) =>
      ['system-disk', 'trash', 'system-folder', 'welcome'].includes(node.id),
    );
    const localeFormatter = vi.spyOn(Date.prototype, 'toLocaleDateString');

    expect(nodes.map(formatInfoCreatedDate)).toEqual([
      '1/24/1984',
      '1/24/1984',
      '1/24/1984',
      '1/24/1984',
    ]);
    expect(localeFormatter).not.toHaveBeenCalled();
  });

  it('retains host-local date formatting for user-created and imported nodes', () => {
    const importedNode: VfsNode = {
      id: 'document-imported',
      parentId: 'system-disk',
      name: 'Imported Note',
      kind: 'document',
      createdAt: '2026-07-31T15:30:00.000Z',
      modifiedAt: '2026-07-31T15:30:00.000Z',
    };
    const localeFormatter = vi
      .spyOn(Date.prototype, 'toLocaleDateString')
      .mockReturnValue('7/31/2026');

    expect(formatInfoCreatedDate(importedNode)).toBe('7/31/2026');
    expect(localeFormatter).toHaveBeenCalledOnce();
  });
});

describe('Rename dialog', () => {
  it('prefills the complete current name and exposes Cancel and Rename actions', () => {
    const nodes = createDefaultState().nodes;
    const node = nodes.find((candidate) => candidate.id === 'read-me');
    if (!node) throw new Error('Missing rename fixture.');

    const markup = renderToStaticMarkup(
      createElement(RenameDialog, {
        interactionCancelToken: 0,
        node,
        nodes,
        onClose: () => undefined,
        onInteractionChange: () => undefined,
        onRename: async () => null,
      }),
    );

    expect(markup).toContain('aria-label="Rename"');
    expect(markup).toContain('value="Read Me"');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('>Cancel</button>');
    expect(markup).toContain('>Rename</button>');
  });

  it('maps every validation failure to specific user-facing feedback', () => {
    const state = createDefaultState();
    const readMe = state.nodes.find((node) => node.id === 'read-me');
    if (!readMe) throw new Error('Missing rename fixture.');
    state.nodes.push({ ...readMe, id: 'collision', name: 'Report' });

    expect(renameValidationMessage(validateVfsRename(state.nodes, readMe.id, ''))).toBe(
      'Enter a name.',
    );
    expect(renameValidationMessage(validateVfsRename(state.nodes, readMe.id, 'x'.repeat(97)))).toBe(
      'Names can contain at most 96 characters.',
    );
    expect(renameValidationMessage(validateVfsRename(state.nodes, readMe.id, 'Bad/Name'))).toBe(
      'Names cannot contain “/” or NUL characters.',
    );
    expect(renameValidationMessage(validateVfsRename(state.nodes, readMe.id, 'report'))).toBe(
      'An item named “report” already exists in this folder.',
    );
    expect(renameValidationMessage(validateVfsRename(state.nodes, 'missing', 'Name'))).toBe(
      'This item can no longer be renamed.',
    );
    expect(
      renameValidationMessage(validateVfsRename(state.nodes, readMe.id, 'New Name')),
    ).toBeNull();
  });

  it('disables Rename when the prefilled name already collides with a sibling', () => {
    const nodes = createDefaultState().nodes;
    const node = nodes.find((candidate) => candidate.id === 'read-me');
    if (!node) throw new Error('Missing rename fixture.');
    nodes.push({ ...node, id: 'duplicate-name' });

    const markup = renderToStaticMarkup(
      createElement(RenameDialog, {
        interactionCancelToken: 0,
        node,
        nodes,
        onClose: () => undefined,
        onInteractionChange: () => undefined,
        onRename: async () => null,
      }),
    );

    expect(markup).toContain('An item named “Read Me” already exists in this folder.');
    expect(markup).toContain(
      '<button class="classic-default-button" disabled="" type="button">Rename</button>',
    );
  });
});
