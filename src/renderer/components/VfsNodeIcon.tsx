import type { VfsNode } from '../../shared/state';
import { PixelIcon, type PixelIconName, type PixelIconVariant } from './PixelIcon';

const iconNameForNode = (node: VfsNode): PixelIconName => {
  if (node.id === 'system-folder') return 'system-folder';
  if (
    node.kind === 'desktop' ||
    node.kind === 'folder' ||
    node.kind === 'disk' ||
    node.kind === 'trash'
  ) {
    return 'folder';
  }
  return 'document';
};

interface VfsNodeIconProps {
  node: VfsNode;
  size: number;
  className?: string;
  variant?: PixelIconVariant;
}

export function VfsNodeIcon({ node, size, className, variant }: VfsNodeIconProps) {
  return (
    <PixelIcon className={className} name={iconNameForNode(node)} size={size} variant={variant} />
  );
}
