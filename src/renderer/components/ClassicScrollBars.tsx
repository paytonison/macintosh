import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

const CLASSIC_SCROLL_STEP = 64;

export type ClassicScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface ClassicScrollTarget {
  scrollBy(options: ScrollToOptions): void;
}

interface ClassicScrollBarsProps<T extends HTMLElement> {
  viewportRef: RefObject<T | null>;
}

export const scrollClassicViewport = (
  viewport: ClassicScrollTarget | null,
  direction: ClassicScrollDirection,
): void => {
  if (!viewport) return;
  switch (direction) {
    case 'up':
      viewport.scrollBy({ top: -CLASSIC_SCROLL_STEP });
      return;
    case 'down':
      viewport.scrollBy({ top: CLASSIC_SCROLL_STEP });
      return;
    case 'left':
      viewport.scrollBy({ left: -CLASSIC_SCROLL_STEP });
      return;
    case 'right':
      viewport.scrollBy({ left: CLASSIC_SCROLL_STEP });
  }
};

export function ClassicScrollBars<T extends HTMLElement>({
  viewportRef,
}: ClassicScrollBarsProps<T>) {
  const preventFocusChange = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
  };
  const scroll = (direction: ClassicScrollDirection): void => {
    scrollClassicViewport(viewportRef.current, direction);
  };

  return (
    <>
      <div className="scrollbar scrollbar-vertical" aria-hidden="true">
        <button
          data-scroll-direction="up"
          onClick={() => scroll('up')}
          onPointerDown={preventFocusChange}
          tabIndex={-1}
          type="button"
        >
          <span className="scroll-arrow up" />
        </button>
        <div className="scroll-track vertical-track">
          <div className="scroll-thumb vertical-thumb" />
        </div>
        <button
          data-scroll-direction="down"
          onClick={() => scroll('down')}
          onPointerDown={preventFocusChange}
          tabIndex={-1}
          type="button"
        >
          <span className="scroll-arrow down" />
        </button>
      </div>
      <div className="scrollbar scrollbar-horizontal" aria-hidden="true">
        <button
          data-scroll-direction="left"
          onClick={() => scroll('left')}
          onPointerDown={preventFocusChange}
          tabIndex={-1}
          type="button"
        >
          <span className="scroll-arrow left" />
        </button>
        <div className="scroll-track horizontal-track">
          <div className="scroll-thumb horizontal-thumb" />
        </div>
        <button
          data-scroll-direction="right"
          onClick={() => scroll('right')}
          onPointerDown={preventFocusChange}
          tabIndex={-1}
          type="button"
        >
          <span className="scroll-arrow right" />
        </button>
      </div>
    </>
  );
}
