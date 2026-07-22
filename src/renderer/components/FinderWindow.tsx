import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

import type {
  FinderViewMode,
  FinderWindowState,
  VfsNode,
  WindowGeometry,
} from '../../shared/state';
import { PixelIcon, type PixelIconName } from './PixelIcon';

interface FinderWindowProps {
  windowState: FinderWindowState;
  node: VfsNode;
  items: VfsNode[];
  active: boolean;
  viewMode: FinderViewMode;
  selectedIds: Set<string>;
  stackIndex: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onGeometry: (id: string, geometry: WindowGeometry) => void;
  onZoom: (id: string) => void;
  onItemSelect: (id: string, additive: boolean) => void;
  onItemOpen: (id: string) => void;
}

interface GeometrySession {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  original: WindowGeometry;
}

const iconForNode = (node: VfsNode): PixelIconName => {
  if (node.id === 'system-folder') return 'system-folder';
  if (node.kind === 'folder' || node.kind === 'disk' || node.kind === 'trash') return 'folder';
  return 'document';
};

export function FinderWindow({
  windowState,
  node,
  items,
  active,
  viewMode,
  selectedIds,
  stackIndex,
  onActivate,
  onClose,
  onGeometry,
  onZoom,
  onItemSelect,
  onItemOpen,
}: FinderWindowProps) {
  const drag = useRef<GeometrySession | null>(null);
  const resize = useRef<GeometrySession | null>(null);
  const content = useRef<HTMLDivElement>(null);

  const beginGeometry = (
    event: ReactPointerEvent<HTMLElement>,
    target: 'drag' | 'resize',
  ): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onActivate(windowState.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    const session = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      original: windowState,
    };
    if (target === 'drag') drag.current = session;
    else resize.current = session;
  };

  const moveWindow = (event: ReactPointerEvent<HTMLElement>): void => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    onGeometry(windowState.id, {
      ...session.original,
      x: Math.round(session.original.x + event.clientX - session.pointerX),
      y: Math.round(session.original.y + event.clientY - session.pointerY),
    });
  };

  const resizeWindow = (event: ReactPointerEvent<HTMLElement>): void => {
    const session = resize.current;
    if (!session || session.pointerId !== event.pointerId) return;
    onGeometry(windowState.id, {
      ...session.original,
      width: Math.max(300, Math.round(session.original.width + event.clientX - session.pointerX)),
      height: Math.max(220, Math.round(session.original.height + event.clientY - session.pointerY)),
    });
  };

  const endGeometry = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    resize.current = null;
  };

  const style = {
    left: windowState.x,
    top: windowState.y,
    width: windowState.width,
    height: windowState.height,
    zIndex: 20 + stackIndex,
  } as CSSProperties;

  const isDocument = node.kind === 'document';

  return (
    <section
      aria-label={`${node.name} window`}
      className={`finder-window ${active ? 'is-active' : 'is-inactive'}`}
      data-finder-window={windowState.id}
      onPointerDown={() => onActivate(windowState.id)}
      style={style}
    >
      <div
        className="window-titlebar"
        onDoubleClick={() => onZoom(windowState.id)}
        onPointerCancel={endGeometry}
        onPointerDown={(event) => beginGeometry(event, 'drag')}
        onPointerMove={moveWindow}
        onPointerUp={endGeometry}
      >
        <button
          aria-label={`Close ${node.name}`}
          className="window-close"
          onClick={(event) => {
            event.stopPropagation();
            onClose(windowState.id);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        />
        <h2>{node.name}</h2>
        <button
          aria-label={`Zoom ${node.name}`}
          className="window-zoom"
          onClick={(event) => {
            event.stopPropagation();
            onZoom(windowState.id);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        />
      </div>
      <div className="window-info-bar">
        <span>
          {isDocument ? '1 page' : `${items.length} item${items.length === 1 ? '' : 's'}`}
        </span>
        <span>{node.kind === 'disk' ? '512K in disk' : 'System Disk'}</span>
        <span>{node.kind === 'disk' ? '184K available' : ''}</span>
      </div>
      <div className="window-scroll-frame">
        <div className="window-content" ref={content}>
          {isDocument ? (
            <article className="document-sheet">{node.content ?? ''}</article>
          ) : viewMode === 'icons' ? (
            <div className="finder-icon-grid">
              {items.map((item) => (
                <button
                  className={`finder-item ${selectedIds.has(item.id) ? 'is-selected' : ''}`}
                  data-vfs-item={item.id}
                  key={item.id}
                  onClick={(event) => onItemSelect(item.id, event.shiftKey)}
                  onDoubleClick={() => onItemOpen(item.id)}
                  type="button"
                >
                  <PixelIcon name={iconForNode(item)} size={48} />
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="finder-list" role="list">
              {items.map((item) => (
                <button
                  className={`finder-list-row ${selectedIds.has(item.id) ? 'is-selected' : ''}`}
                  data-vfs-item={item.id}
                  key={item.id}
                  onClick={(event) => onItemSelect(item.id, event.shiftKey)}
                  onDoubleClick={() => onItemOpen(item.id)}
                  role="listitem"
                  type="button"
                >
                  <PixelIcon name={iconForNode(item)} size={24} />
                  <span>{item.name}</span>
                  <span className="finder-kind">{item.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="scrollbar scrollbar-vertical" aria-hidden="true">
          <button
            onClick={() => content.current?.scrollBy({ top: -64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow up" />
          </button>
          <div className="scroll-track vertical-track">
            <div className="scroll-thumb vertical-thumb" />
          </div>
          <button
            onClick={() => content.current?.scrollBy({ top: 64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow down" />
          </button>
        </div>
        <div className="scrollbar scrollbar-horizontal" aria-hidden="true">
          <button
            onClick={() => content.current?.scrollBy({ left: -64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow left" />
          </button>
          <div className="scroll-track horizontal-track">
            <div className="scroll-thumb horizontal-thumb" />
          </div>
          <button
            onClick={() => content.current?.scrollBy({ left: 64 })}
            tabIndex={-1}
            type="button"
          >
            <span className="scroll-arrow right" />
          </button>
        </div>
        <button
          aria-label={`Resize ${node.name}`}
          className="window-grow-box"
          onPointerCancel={endGeometry}
          onPointerDown={(event) => beginGeometry(event, 'resize')}
          onPointerMove={resizeWindow}
          onPointerUp={endGeometry}
          type="button"
        >
          <span />
        </button>
      </div>
    </section>
  );
}
