import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ClassicScrollBars, scrollClassicViewport } from './ClassicScrollBars';

describe('classic scroll bars', () => {
  it('renders the shared vertical and horizontal Finder controls', () => {
    const markup = renderToStaticMarkup(<ClassicScrollBars viewportRef={{ current: null }} />);

    expect(markup).toContain('scrollbar scrollbar-vertical');
    expect(markup).toContain('scrollbar scrollbar-horizontal');
    expect(markup).toContain('scroll-track vertical-track');
    expect(markup).toContain('scroll-track horizontal-track');
    expect(markup).toContain('scroll-thumb vertical-thumb');
    expect(markup).toContain('scroll-thumb horizontal-thumb');
    expect(markup.match(/data-scroll-direction=/g)).toHaveLength(4);
  });

  it('scrolls only the supplied viewport in fixed classic increments', () => {
    const scrollBy = vi.fn();
    const viewport = { scrollBy };

    scrollClassicViewport(viewport, 'up');
    scrollClassicViewport(viewport, 'down');
    scrollClassicViewport(viewport, 'left');
    scrollClassicViewport(viewport, 'right');

    expect(scrollBy.mock.calls).toEqual([
      [{ top: -64 }],
      [{ top: 64 }],
      [{ left: -64 }],
      [{ left: 64 }],
    ]);
  });
});
