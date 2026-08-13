import type { VfsNode } from '../../shared/state';

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const orderNodesForIconCleanup = (nodes: readonly VfsNode[]): VfsNode[] =>
  [...nodes].sort((left, right) => {
    const nameOrder = compareCodeUnits(left.name.toLowerCase(), right.name.toLowerCase());
    return nameOrder || compareCodeUnits(left.id, right.id);
  });
