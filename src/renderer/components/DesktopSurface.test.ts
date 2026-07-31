import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveDesktopDropTarget } from './DesktopSurface';

class FakeElement {
  readonly dataset: DOMStringMap;
  readonly parentElement: FakeElement | null;

  constructor(dataset: Record<string, string> = {}, parentElement: FakeElement | null = null) {
    this.dataset = dataset as DOMStringMap;
    this.parentElement = parentElement;
  }

  contains(candidate: unknown): boolean {
    let current = candidate as FakeElement | null;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }
}

const asHtml = (element: FakeElement): HTMLElement => element as unknown as HTMLElement;
const asTarget = (element: FakeElement): EventTarget => element as unknown as EventTarget;

describe('Desktop drop-target precedence', () => {
  beforeEach(() => {
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLElement', FakeElement);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses bare Desktop but gives explicit folders and System Disk precedence', () => {
    const surface = new FakeElement({ dropDestination: 'desktop' });
    const folder = new FakeElement({ vfsNodeId: 'projects', dropDestination: 'projects' }, surface);
    const disk = new FakeElement({ dropDestination: 'system-disk' }, surface);

    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(surface), false)?.destinationId).toBe(
      'desktop',
    );
    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(folder), false)?.destinationId).toBe(
      'projects',
    );
    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(disk), true)?.destinationId).toBe(
      'system-disk',
    );
  });

  it('blocks documents and rejects external Trash drops without falling through', () => {
    const surface = new FakeElement({ dropDestination: 'desktop' });
    const documentItem = new FakeElement({ vfsNodeId: 'note', dropBlocked: 'true' }, surface);
    const trash = new FakeElement({ dropDestination: 'trash', dropMode: 'internal' }, surface);
    const trashWindowCanvas = new FakeElement({ dropDestination: 'trash' }, surface);

    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(documentItem), false)).toBeNull();
    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(documentItem), true)).toBeNull();
    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(trash), true)).toBeNull();
    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(trashWindowCanvas), true)).toBeNull();
    expect(resolveDesktopDropTarget(asHtml(surface), asTarget(trash), false)?.destinationId).toBe(
      'trash',
    );
    expect(
      resolveDesktopDropTarget(asHtml(surface), asTarget(trashWindowCanvas), false)?.destinationId,
    ).toBe('trash');
  });

  it('ignores dragged items and descendants so their parent layout receives the drop', () => {
    const surface = new FakeElement({ dropDestination: 'desktop' });
    const draggedFolder = new FakeElement(
      { vfsNodeId: 'projects', dropDestination: 'projects' },
      surface,
    );

    expect(
      resolveDesktopDropTarget(
        asHtml(surface),
        asTarget(draggedFolder),
        false,
        new Set(['projects']),
      )?.destinationId,
    ).toBe('desktop');
  });
});
