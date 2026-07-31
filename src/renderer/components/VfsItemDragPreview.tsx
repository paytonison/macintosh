import type { CSSProperties } from 'react';

import type { Point, VfsNode } from '../../shared/state';
import {
  resolveIconDragPreviewPosition,
  type IconDragPreviewItem,
} from '../model/icon-drag-preview';
import { VfsNodeIcon } from './VfsNodeIcon';

interface VfsItemDragPreviewProps {
  items: IconDragPreviewItem[];
  nodes: VfsNode[];
  pointer: Point;
  solidShadowIds: ReadonlySet<string>;
}

export function VfsItemDragPreview({
  items,
  nodes,
  pointer,
  solidShadowIds,
}: VfsItemDragPreviewProps) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  return (
    <div aria-hidden="true" className="vfs-item-drag-preview" data-vfs-item-drag-preview="true">
      {items.map((item) => {
        const node = nodesById.get(item.nodeId);
        if (!node) return null;
        const position = resolveIconDragPreviewPosition(item, pointer);
        return (
          <span
            className={`vfs-item-drag-preview-icon ${solidShadowIds.has(item.nodeId) ? 'is-solid-shadow' : ''}`.trim()}
            data-vfs-item-drag-preview-node={item.nodeId}
            key={item.nodeId}
            style={
              {
                height: item.size,
                left: position.x,
                top: position.y,
                width: item.size,
              } as CSSProperties
            }
          >
            <VfsNodeIcon
              className="pixel-icon-drag-shadow"
              node={node}
              size={item.size}
              variant="shadow"
            />
            <VfsNodeIcon className="pixel-icon-drag-artwork" node={node} size={item.size} />
          </span>
        );
      })}
    </div>
  );
}
