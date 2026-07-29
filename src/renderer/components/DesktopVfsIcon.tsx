import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
} from 'react';

import type { Point, VfsNode } from '../../shared/state';
import { VfsNodeIcon } from './VfsNodeIcon';

interface DesktopVfsIconProps {
  interactionCancelToken: number;
  node: VfsNode;
  position: Point;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
  onOpen: (id: string, source: HTMLElement) => void;
  onDragStart: (id: string, dataTransfer: DataTransfer, pointerOffset: Point) => void;
  onDragEnd: () => void;
}

export function DesktopVfsIcon({
  interactionCancelToken,
  node,
  position,
  selected,
  onSelect,
  onOpen,
  onDragStart,
  onDragEnd,
}: DesktopVfsIconProps) {
  const icon = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    icon.current?.classList.remove('is-dragging');
  }, [interactionCancelToken]);

  const beginDrag = (event: ReactDragEvent<HTMLButtonElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.classList.add('is-dragging');
    onDragStart(node.id, event.dataTransfer, {
      x: Math.round(event.clientX - bounds.left),
      y: Math.round(event.clientY - bounds.top),
    });
  };

  const finishDrag = (event: ReactDragEvent<HTMLButtonElement>): void => {
    event.currentTarget.classList.remove('is-dragging');
    onDragEnd();
  };

  const style = {
    '--icon-x': `${Math.round(position.x)}px`,
    '--icon-y': `${Math.round(position.y)}px`,
  } as CSSProperties;

  return (
    <button
      aria-label={node.name}
      className={['desktop-icon', 'desktop-vfs-icon', selected ? 'is-selected' : '']
        .filter(Boolean)
        .join(' ')}
      data-desktop-icon={node.id}
      data-desktop-vfs-item={node.id}
      data-drop-blocked={node.kind === 'folder' ? undefined : 'true'}
      data-drop-destination={node.kind === 'folder' ? node.id : undefined}
      data-icon-x={position.x}
      data-icon-y={position.y}
      data-vfs-node-id={node.id}
      draggable
      onClick={(event) => onSelect(node.id, event.shiftKey)}
      onDoubleClick={(event) => onOpen(node.id, event.currentTarget)}
      onDragEnd={finishDrag}
      onDragStart={beginDrag}
      ref={icon}
      style={style}
      type="button"
    >
      <span className="desktop-icon-glyph">
        <VfsNodeIcon node={node} size={32} />
      </span>
      <span className="desktop-icon-label" data-desktop-icon-label={node.id}>
        {node.name}
      </span>
    </button>
  );
}
