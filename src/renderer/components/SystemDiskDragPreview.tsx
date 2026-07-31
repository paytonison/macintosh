import type { CSSProperties } from 'react';

import type { Point } from '../../shared/state';
import {
  resolveIconDragPreviewPosition,
  type IconDragPreviewItem,
} from '../model/icon-drag-preview';
import { PixelIcon } from './PixelIcon';

interface SystemDiskDragPreviewProps {
  item: IconDragPreviewItem;
  pointer: Point;
  solidShadow: boolean;
}

export function SystemDiskDragPreview({ item, pointer, solidShadow }: SystemDiskDragPreviewProps) {
  const position = resolveIconDragPreviewPosition(item, pointer);

  return (
    <div aria-hidden="true" className="vfs-item-drag-preview" data-system-disk-drag-preview="true">
      <span
        className={`vfs-item-drag-preview-icon ${solidShadow ? 'is-solid-shadow' : ''}`.trim()}
        data-system-disk-drag-preview-icon="true"
        style={
          {
            height: item.size,
            left: position.x,
            top: position.y,
            width: item.size,
          } as CSSProperties
        }
      >
        <PixelIcon
          className="pixel-icon-drag-shadow"
          name="disk"
          size={item.size}
          variant="shadow"
        />
        <PixelIcon className="pixel-icon-drag-artwork" name="disk" size={item.size} />
      </span>
    </div>
  );
}
