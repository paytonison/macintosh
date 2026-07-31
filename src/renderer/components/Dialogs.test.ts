import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultState } from '../../shared/state';
import { formatInfoCreatedDate, InfoDialog } from './Dialogs';

describe('Get Info creation date', () => {
  it('renders the canonical System Disk date exactly', () => {
    const disk = createDefaultState().nodes.find((node) => node.id === 'system-disk');
    if (!disk) throw new Error('Missing System Disk fixture.');

    const markup = renderToStaticMarkup(
      createElement(InfoDialog, {
        interactionCancelToken: 0,
        node: disk,
        onClose: () => undefined,
        onInteractionChange: () => undefined,
        where: 'Desktop',
      }),
    );

    expect(markup).toContain('<dt>Created:</dt><dd>1/4/1984</dd>');
  });

  it('does not consult the host locale for System Disk', () => {
    const disk = createDefaultState().nodes.find((node) => node.id === 'system-disk');
    if (!disk) throw new Error('Missing System Disk fixture.');
    const localeFormatter = vi.spyOn(Date.prototype, 'toLocaleDateString');

    expect(formatInfoCreatedDate(disk)).toBe('1/4/1984');
    expect(localeFormatter).not.toHaveBeenCalled();
    localeFormatter.mockRestore();
  });
});
