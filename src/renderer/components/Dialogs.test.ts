import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultState, type VfsNode } from '../../shared/state';
import { formatInfoCreatedDate, InfoDialog } from './Dialogs';

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
