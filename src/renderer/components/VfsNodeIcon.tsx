import type { VfsNode } from '../../shared/state';
import { PixelIcon, type PixelIconName } from './PixelIcon';

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

export function VfsNodeIcon({ node, size }: { node: VfsNode; size: number }) {
  return <PixelIcon name={iconNameForNode(node)} size={size} />;
}
